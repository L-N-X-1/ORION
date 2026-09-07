from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Optional

import simpy
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from dataset_loader import DatasetLoader
from event_generator import EventGenerator
from fault_injector import FaultInjector
from kpi_synthesizer import KpiSynthesizer
from mobility import MobilityProcess
from whatif_runner import WhatIfRunner
from world_state import EnergyMode, WorldState

# ── Config ──────────────────────────────────────────────────────────
TICK_INTERVAL_S = int(os.getenv("TICK_INTERVAL_S", "5"))
INFLUXDB_URL    = os.getenv("INFLUXDB_URL", "")
INFLUXDB_TOKEN  = os.getenv("INFLUXDB_TOKEN", "")
INFLUXDB_ORG    = os.getenv("INFLUXDB_ORG", "aura-net")
INFLUXDB_BUCKET = os.getenv("INFLUXDB_BUCKET", "aura_net")
KAFKA_BROKERS   = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "")
AGENT_URL       = os.getenv("AGENT_URL", "http://ai-agent:8003")

# ── Globals ─────────────────────────────────────────────────────────
state    = WorldState()
dataset  = DatasetLoader()
synth    = KpiSynthesizer()
mobility = MobilityProcess()
whatif   = WhatIfRunner(dataset)

_tick_counter = 0
_sim_running  = True
_state_lock   = threading.Lock()

# ── InfluxDB writer (optional) ──────────────────────────────────────
_influx_write = None
if INFLUXDB_URL and INFLUXDB_TOKEN:
    try:
        from influxdb_client import InfluxDBClient
        from influxdb_client.client.write_api import SYNCHRONOUS
        _influx_client = InfluxDBClient(
            url=INFLUXDB_URL, token=INFLUXDB_TOKEN, org=INFLUXDB_ORG
        )
        _influx_write = _influx_client.write_api(write_options=SYNCHRONOUS)
        print("[main] InfluxDB connected")
    except Exception as e:
        print(f"[main] InfluxDB unavailable: {e}")


def _write_to_influx(kpis: list[dict]) -> None:
    if not _influx_write:
        return
    try:
        from influxdb_client import Point
        points = []
        for k in kpis:
            p = (Point("cell_kpi")
                 .tag("cell_id",     k["cell_id"])
                 .tag("energy_mode", k["energy_mode"])
                 .field("prb_util",        k["prb_util"])
                 .field("throughput_mbps", k["throughput_mbps"])
                 .field("sinr_db",         k["sinr_db"])
                 .field("cqi",             float(k["cqi"]))
                 .field("latency_p95_ms",  k["latency_p95_ms"])
                 .field("packet_loss_pct", k["packet_loss_pct"])
                 .field("cpu_load_pct",    k["cpu_load_pct"])
                 .field("ho_fail_rate",    k["ho_fail_rate"])
                 .field("sla_violation",   int(k["sla_violation"]))
                 .field("is_peak",         int(k["is_peak"]))
            )
            points.append(p)
        _influx_write.write(bucket=INFLUXDB_BUCKET, org=INFLUXDB_ORG, record=points)
    except Exception as e:
        print(f"[main] InfluxDB write error: {e}")


# ── Kafka producer (sync, for use from the simulation thread) ────────
_kafka_producer = None

if KAFKA_BROKERS:
    try:
        from kafka import KafkaProducer
        _kafka_producer = KafkaProducer(
            bootstrap_servers=KAFKA_BROKERS,
        )
        print(f"[main] Kafka producer connected to {KAFKA_BROKERS}")
    except Exception as e:
        print(f"[main] Kafka producer unavailable: {e}")


def _publish_kpis(kpis: list[dict]) -> None:
    if not _kafka_producer:
        return
    for k in kpis:
        payload = {
            "entity_id":       k["cell_id"],
            "timestamp":       datetime.now(timezone.utc).isoformat(),
            "prb_utilization": k["prb_util"],
            "throughput_mbps": k["throughput_mbps"],
            "sinr_db":         k["sinr_db"],
            "cqi":             k["cqi"],
            "latency_p95_ms":  k["latency_p95_ms"],
            "packet_loss_pct": k["packet_loss_pct"],
            "cpu_load_pct":    k["cpu_load_pct"],
            "ho_fail_rate":    k["ho_fail_rate"],
            "energy_mode":     k["energy_mode"],
            "sla_violation":   k["sla_violation"],
            "is_peak":         k["is_peak"],
        }
        try:
            _kafka_producer.send("aura.kpi.v1", json.dumps(payload).encode("utf-8"))
        except Exception as e:
            print(f"[main] KPI publish error: {e}")


# ── EventGenerator — wired with Kafka producer ───────────────────────
events = EventGenerator(kafka_producer=_kafka_producer)


# ── SimPy simulation loop ────────────────────────────────────────────

def _simulation_loop() -> None:
    global _tick_counter
    env = simpy.Environment()

    def tick(env):
        global _tick_counter
        while _sim_running:
            tick_no = _tick_counter
            is_peak = dataset.is_peak_hour(tick_no)

            with _state_lock:
                _sf_cells = {
                    cid for sf in state.synthetic_faults.values()
                    for cid in sf.get("cells", [])
                }
                for cid, cell in state.cells.items():
                    if cid not in state.pinned_loads and cid not in _sf_cells:
                        cell.current_load = dataset.get_load_factor(cid, tick_no)
                for cid, load in state.pinned_loads.items():
                    if cid in state.cells:
                        state.cells[cid].current_load = load
                for sf in state.synthetic_faults.values():
                    for cid in sf.get("cells", []):
                        if cid in state.cells:
                            state.cells[cid].current_load = sf["prb_override"]

            mobility.run_tick(state)

            with _state_lock:
                for cid, load in state.pinned_loads.items():
                    if cid in state.cells:
                        state.cells[cid].current_load = load
                for sf in state.synthetic_faults.values():
                    for cid in sf.get("cells", []):
                        if cid in state.cells:
                            state.cells[cid].current_load = sf["prb_override"]

            kpis = synth.synthesize(state, tick_no, is_peak)

            # Events — published to Kafka automatically via EventGenerator
            new_events = events.evaluate(kpis, state)
            if new_events:
                print(f"[main] tick={tick_no} emitted {len(new_events)} event(s): "
                      f"{[e['event_type'] for e in new_events]}")

            # KPIs — published to Kafka + InfluxDB
            _publish_kpis(kpis)
            _write_to_influx(kpis)

            state.sim_time_s += TICK_INTERVAL_S
            _tick_counter    += 1

            yield env.timeout(1)

    env.process(tick(env))

    while _sim_running:
        env.step()
        time.sleep(TICK_INTERVAL_S)


_sim_thread = threading.Thread(target=_simulation_loop, daemon=True)
_sim_thread.start()


# ── FastAPI app ──────────────────────────────────────────────────────
app = FastAPI(title="AURA-NET Digital Twin", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {
        "status":          "ok",
        "service":         "digital-twin",
        "sim_time_s":      state.sim_time_s,
        "tick":            _tick_counter,
        "cells":           len(state.cells),
        "tick_interval_s": TICK_INTERVAL_S,
        "kafka":           "connected" if _kafka_producer else "not connected",
        "influxdb":        "connected" if _influx_write else "not connected",
        "dataset_dir":     os.getenv("DATASET_DIR", "/data/telecom"),
        "dataset_sources": dataset.list_sources(),
    }


@app.get("/metrics")
def get_metrics(
    cell_id: str | None = Query(None),
    last_n:  int        = Query(10, ge=1, le=60),
):
    if cell_id:
        if cell_id not in state.cells:
            raise HTTPException(404, f"Cell {cell_id} not found")
        return {
            "cell_id":     cell_id,
            "kpis":        state.get_kpi_history(cell_id, last_n),
            "pinned_load": state.pinned_loads.get(cell_id),
        }
    return {
        "kpis":         state.get_all_latest_kpis(),
        "pinned_loads": dict(state.pinned_loads),
    }


@app.get("/topology")
def get_topology(entity_id: str | None = Query(None)):
    return state.get_topology(entity_id)


@app.get("/events")
def get_events(
    entity_id: str | None = Query(None),
    limit:     int        = Query(50, ge=1, le=500),
):
    if entity_id:
        return {"events": events.get_events_for_entity(entity_id, limit)}
    return {"events": events.get_recent_events(limit)}


class WhatIfRequest(BaseModel):
    action_plan:   dict
    horizon_ticks: int = 120


@app.post("/whatif/run")
def run_whatif(req: WhatIfRequest):
    return whatif.run(state, req.action_plan, req.horizon_ticks)


class SlicePolicyRequest(BaseModel):
    slice_id:   str
    min_bw_pct: float | None = None
    max_bw_pct: float | None = None
    priority:   int   | None = None


@app.post("/actions/apply_slice_policy")
def apply_slice_policy(req: SlicePolicyRequest):
    if req.slice_id not in state.slices:
        raise HTTPException(404, f"Slice {req.slice_id} not found")
    with _state_lock:
        sl = state.slices[req.slice_id]
        previous = {
            "min_bw_pct": sl.min_bw_pct,
            "max_bw_pct": sl.max_bw_pct,
            "priority":   sl.priority,
        }
        if req.min_bw_pct is not None: sl.min_bw_pct = req.min_bw_pct
        if req.max_bw_pct is not None: sl.max_bw_pct = req.max_bw_pct
        if req.priority   is not None: sl.priority   = req.priority
        # clear synthetic congestion fault — the slice policy remediation "worked"
        state.synthetic_faults.pop("evening_congestion", None)
        change_id = f"CHG-{uuid.uuid4().hex[:6].upper()}"
        state.change_records[change_id] = {
            "type": "slice_policy", "slice_id": req.slice_id,
            "params": req.model_dump(), "previous": previous,
            "sim_time_s": state.sim_time_s,
        }
    return {"change_id": change_id, "applied": req.model_dump()}


class HandoverRequest(BaseModel):
    cell_id:   str
    a3_offset: float | None = None
    ttt_ms:    float | None = None


@app.post("/actions/tune_handover")
def tune_handover(req: HandoverRequest):
    if req.cell_id not in state.cells:
        raise HTTPException(404, f"Cell {req.cell_id} not found")
    with _state_lock:
        cell = state.cells[req.cell_id]
        previous = {"a3_offset": cell.a3_offset, "ttt_ms": cell.ttt_ms}
        if req.a3_offset is not None: cell.a3_offset = req.a3_offset
        if req.ttt_ms    is not None: cell.ttt_ms    = req.ttt_ms
        change_id = f"CHG-{uuid.uuid4().hex[:6].upper()}"
        state.change_records[change_id] = {
            "type": "tune_handover", "cell_id": req.cell_id,
            "params": req.model_dump(), "previous": previous,
            "sim_time_s": state.sim_time_s,
        }
    return {"change_id": change_id, "applied": req.model_dump()}


class EnergyModeRequest(BaseModel):
    cell_id: str
    mode:    str


@app.post("/actions/enable_energy_saving")
def enable_energy_saving(req: EnergyModeRequest):
    if req.cell_id not in state.cells:
        raise HTTPException(404, f"Cell {req.cell_id} not found")
    try:
        mode = EnergyMode(req.mode)
    except ValueError:
        raise HTTPException(400, f"Invalid mode '{req.mode}'. Use ACTIVE, SLEEP, or SHUTDOWN")
    with _state_lock:
        cell = state.cells[req.cell_id]
        previous = {"mode": cell.energy_mode.value}
        cell.energy_mode = mode
        change_id = f"CHG-{uuid.uuid4().hex[:6].upper()}"
        state.change_records[change_id] = {
            "type": "energy_mode", "cell_id": req.cell_id,
            "mode": req.mode, "previous": previous,
            "sim_time_s": state.sim_time_s,
        }
    return {"change_id": change_id, "applied": req.model_dump()}


class RollbackRequest(BaseModel):
    change_id: str


@app.post("/actions/rollback")
def rollback(req: RollbackRequest):
    record = state.change_records.get(req.change_id)
    if not record:
        raise HTTPException(404, f"Change {req.change_id} not found")
    t = record["type"]
    # "previous" holds the actual pre-change values captured when the action
    # was applied (older records made before this field existed fall back to
    # factory defaults, since no prior snapshot exists for them).
    previous = record.get("previous", {})
    with _state_lock:
        if t == "energy_mode":
            cell = state.cells.get(record["cell_id"])
            if cell:
                cell.energy_mode = EnergyMode(previous.get("mode", "ACTIVE"))
        elif t == "tune_handover":
            cell = state.cells.get(record["cell_id"])
            if cell:
                cell.a3_offset = previous.get("a3_offset", 3.0)
                cell.ttt_ms    = previous.get("ttt_ms", 40.0)
        elif t == "slice_policy":
            params = record.get("params", {})
            sl = state.slices.get(params.get("slice_id", ""))
            if sl:
                sl.min_bw_pct = previous.get("min_bw_pct", sl.min_bw_pct)
                sl.max_bw_pct = previous.get("max_bw_pct", sl.max_bw_pct)
                sl.priority   = previous.get("priority", sl.priority)
    return {"rolled_back": req.change_id, "record": record}


class FaultRequest(BaseModel):
    scenario: str
    params:   dict = {}


@app.post("/fault/inject")
def inject_fault(req: FaultRequest):
    fn = getattr(FaultInjector, req.scenario, None)
    if fn is None:
        raise HTTPException(400,
            f"Unknown scenario '{req.scenario}'. "
            "Available: evening_congestion, backhaul_degradation, "
            "mobility_storm, policy_misconfiguration, energy_saving_failure")
    with _state_lock:
        result = fn(state, **req.params)
    return {"injected": result}


@app.post("/fault/restore")
def restore_fault(req: FaultRequest):
    fn = getattr(FaultInjector, f"restore_{req.scenario}", None)
    if fn is None:
        raise HTTPException(400,
            f"No restore method for '{req.scenario}'. "
            "Available: backhaul, energy_mode, slice_priorities, handover_params, evening_congestion")
    with _state_lock:
        result = fn(state, **req.params)
    return {"restored": result}


class AgentFaultRequest(BaseModel):
    scenario: str = "evening_congestion"
    cells: Optional[list[str]] = None


def _fire_agent_event(event_payload: dict) -> None:
    """Background thread: wait one tick then POST event to AI agent /run."""
    time.sleep(TICK_INTERVAL_S + 1)  # let SimPy apply synthetic fault to cell loads
    try:
        body = json.dumps(event_payload).encode("utf-8")
        req_obj = urllib.request.Request(
            f"{AGENT_URL}/run",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req_obj, timeout=300) as resp:
            result = json.loads(resp.read())
            print(f"[agent-fault] pipeline result: {result.get('status') or result.get('verification_report')}")
    except Exception as exc:
        print(f"[agent-fault] pipeline fire error: {exc}")


@app.post("/fault/inject-agent", summary="Inject ephemeral fault and trigger AI agent pipeline")
def inject_agent_fault(req: AgentFaultRequest):
    """
    Injects a synthetic fault (no SimPy pin) and fires a NetworkEvent directly
    to the AI agent /run endpoint in a background thread.
    The agent's apply_slice_policy action clears the fault → verifier sees clean KPIs → success.
    """
    fn = getattr(FaultInjector, f"agent_{req.scenario}", None)
    if fn is None:
        raise HTTPException(400, f"Unknown agent scenario '{req.scenario}'. Available: evening_congestion")
    params = {"cells": req.cells} if req.cells else {}
    with _state_lock:
        result = fn(state, **params)

    event_id   = f"evt-agent-{uuid.uuid4().hex[:8]}"
    incident_id = f"INC-{uuid.uuid4().hex[:8].upper()}"
    targets = result.get("targets", ["C00"])
    event_payload = {
        "event_id":       event_id,
        "correlation_id": event_id,
        "event_type":     "CONGESTION",
        "entity_id":      targets[0],
        "severity_hint":  "high",
        "sim_time_s":     state.sim_time_s,
        "timestamp":      datetime.now(timezone.utc).isoformat(),
        "extra":          {"suggested_incident_id": incident_id},
    }
    threading.Thread(target=_fire_agent_event, args=(event_payload,), daemon=True).start()
    return {
        "injected":    result,
        "event_id":    event_id,
        "incident_id": incident_id,
        "agent_url":   f"{AGENT_URL}/run",
        "note":        "Agent pipeline running in background. Check /approvals if human approval required.",
    }


@app.post("/fault/restore-agent", summary="Manually restore an ephemeral agent fault")
def restore_agent_fault(req: AgentFaultRequest):
    fn = getattr(FaultInjector, f"restore_agent_{req.scenario}", None)
    if fn is None:
        raise HTTPException(400, f"No agent restore for '{req.scenario}'. Available: evening_congestion")
    params = {"cells": req.cells} if req.cells else {}
    with _state_lock:
        result = fn(state, **params)
    return {"restored": result}


@app.get("/snapshot")
def snapshot():
    return state.snapshot()

# ── UI-facing read models ────────────────────────────────────────────
# Everything below is additive and read-only (except nothing mutates
# WorldState). It exists so the Digital Twin UI can render change history,
# the active-fault surface and UE distribution without scraping /snapshot.

@app.get("/changes", summary="All change records applied to the twin")
def list_changes():
    with _state_lock:
        records = [
            {"change_id": cid, **record}
            for cid, record in state.change_records.items()
        ]
    # newest first — change_records is insertion-ordered
    records.reverse()
    return {"changes": records, "count": len(records)}


@app.get("/faults", summary="Everything currently deviating from the nominal baseline")
def list_faults():
    with _state_lock:
        degraded_backhaul = [
            bh.to_dict() for bh in state.backhaul.values()
            if bh.status.value != "UP"
        ]
        non_active_cells = [
            {"cell_id": c.cell_id, "energy_mode": c.energy_mode.value}
            for c in state.cells.values()
            if c.energy_mode != EnergyMode.ACTIVE
        ]
        handover_anomalies = [
            {"cell_id": c.cell_id, "a3_offset": c.a3_offset, "ttt_ms": c.ttt_ms}
            for c in state.cells.values()
            if c.a3_offset < 1.0
        ]
        premium = state.slices.get("slice-premium")
        iot     = state.slices.get("slice-iot")
        slice_inverted = bool(premium and iot and premium.priority > iot.priority)
        payload = {
            "pinned_loads":       dict(state.pinned_loads),
            "synthetic_faults":   {k: dict(v) for k, v in state.synthetic_faults.items()},
            "degraded_backhaul":  degraded_backhaul,
            "non_active_cells":   non_active_cells,
            "handover_anomalies": handover_anomalies,
            "slice_priority_inverted": slice_inverted,
        }
    payload["active"] = bool(
        payload["pinned_loads"]
        or payload["synthetic_faults"]
        or degraded_backhaul
        or non_active_cells
        or handover_anomalies
        or slice_inverted
    )
    return payload


@app.get("/ues", summary="UE distribution per cell and per slice")
def list_ues():
    with _state_lock:
        per_cell: dict[str, dict] = {
            cid: {"total": 0, "by_slice": {}} for cid in state.cells
        }
        by_slice: dict[str, int] = {sid: 0 for sid in state.slices}
        for ue in state.ues.values():
            bucket = per_cell.setdefault(ue.serving_cell, {"total": 0, "by_slice": {}})
            bucket["total"] += 1
            bucket["by_slice"][ue.slice_id] = bucket["by_slice"].get(ue.slice_id, 0) + 1
            by_slice[ue.slice_id] = by_slice.get(ue.slice_id, 0) + 1
        total = len(state.ues)
    return {"total": total, "per_cell": per_cell, "by_slice": by_slice}


# ── Live telemetry WebSocket ─────────────────────────────────────────
# The SimPy loop runs in a plain thread, so instead of pushing from that
# thread into the asyncio loop we let each socket watch the tick counter
# and emit a frame whenever it advances. Reads are cheap in-memory reads
# guarded by the same lock the sim thread uses.

WS_POLL_INTERVAL_S = 0.5
WS_KEEPALIVE_S     = 20.0


def _telemetry_frame(frame_type: str = "tick") -> dict:
    with _state_lock:
        return {
            "type":             frame_type,
            "tick":             _tick_counter,
            "sim_time_s":       state.sim_time_s,
            "tick_interval_s":  TICK_INTERVAL_S,
            "ts":               datetime.now(timezone.utc).isoformat(),
            "kpis":             state.get_all_latest_kpis(),
            "cells":            {k: v.to_dict() for k, v in state.cells.items()},
            "slices":           {k: v.to_dict() for k, v in state.slices.items()},
            "backhaul":         {k: v.to_dict() for k, v in state.backhaul.items()},
            "events":           events.get_recent_events(30),
            "pinned_loads":     dict(state.pinned_loads),
            "synthetic_faults": {k: dict(v) for k, v in state.synthetic_faults.items()},
        }


@app.websocket("/ws/telemetry")
async def ws_telemetry(ws: WebSocket):
    await ws.accept()
    last_tick = -1
    idle_s    = 0.0
    try:
        await ws.send_json(_telemetry_frame("snapshot"))
        last_tick = _tick_counter
        while True:
            await asyncio.sleep(WS_POLL_INTERVAL_S)
            if _tick_counter != last_tick:
                last_tick = _tick_counter
                idle_s    = 0.0
                await ws.send_json(_telemetry_frame("tick"))
            else:
                idle_s += WS_POLL_INTERVAL_S
                if idle_s >= WS_KEEPALIVE_S:
                    idle_s = 0.0
                    await ws.send_json({"type": "heartbeat", "tick": last_tick})
    except WebSocketDisconnect:
        return
    except Exception as exc:  # client vanished mid-send, encoder error, etc.
        print(f"[ws] telemetry socket closed: {exc}")
        return
