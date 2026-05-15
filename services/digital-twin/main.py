"""
AURA-NET Digital Twin Service — main.py
Ticket: AN-TWN-001

FastAPI application that:
  1. Runs the SimPy simulation in a background thread.
  2. Exposes REST endpoints consumed by agents and the collector.
  3. Optionally writes KPIs to InfluxDB and events to Kafka.
"""
from __future__ import annotations

import os
import threading
import time
import uuid

import simpy
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from world_state import WorldState, EnergyMode
from dataset_loader import DatasetLoader
from kpi_synthesizer import KpiSynthesizer
from mobility import MobilityProcess
from event_generator import EventGenerator
from fault_injector import FaultInjector
from whatif_runner import WhatIfRunner

# ── Config ──────────────────────────────────────────────────────────
TICK_INTERVAL_S = int(os.getenv("TICK_INTERVAL_S", "5"))
INFLUXDB_URL    = os.getenv("INFLUXDB_URL", "")
INFLUXDB_TOKEN  = os.getenv("INFLUXDB_TOKEN", "")
INFLUXDB_ORG    = os.getenv("INFLUXDB_ORG", "aura-net")
INFLUXDB_BUCKET = os.getenv("INFLUXDB_BUCKET", "aura_net")
KAFKA_BROKERS   = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "")

# ── Globals ─────────────────────────────────────────────────────────
state    = WorldState()
dataset  = DatasetLoader()          # reads DATASET_DIR + DATASET_SOURCES from env
synth    = KpiSynthesizer()
mobility = MobilityProcess()
events   = EventGenerator()
whatif   = WhatIfRunner(dataset)

_tick_counter = 0
_sim_running  = True

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


# ── SimPy simulation loop ────────────────────────────────────────────

def _simulation_loop() -> None:
    global _tick_counter
    env = simpy.Environment()

    def tick(env):
        global _tick_counter
        while _sim_running:
            tick_no = _tick_counter
            is_peak = dataset.is_peak_hour(tick_no)

            # 1. Update cell loads from dataset
            for cid, cell in state.cells.items():
                cell.current_load = dataset.get_load_factor(cid, tick_no)

            # 2. Run mobility
            mobility.run_tick(state)

            # 3. Synthesize KPIs
            kpis = synth.synthesize(state, tick_no, is_peak)

            # 4. Emit events
            events.evaluate(kpis, state)

            # 5. Write to InfluxDB
            _write_to_influx(kpis)

            # 6. Advance clocks
            state.sim_time_s += TICK_INTERVAL_S
            _tick_counter    += 1

            yield env.timeout(1)

    env.process(tick(env))

    # Run one SimPy step per wall-clock TICK_INTERVAL_S seconds
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


# ── Health ────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    """
    Returns service health plus dataset source info per cell.
    Useful to confirm which cells are using real CSV data vs synthetic fallback.
    """
    return {
        "status":          "ok",
        "service":         "digital-twin",
        "sim_time_s":      state.sim_time_s,
        "tick":            _tick_counter,
        "cells":           len(state.cells),
        "tick_interval_s": TICK_INTERVAL_S,
        "influxdb":        "connected" if _influx_write else "not connected",
        "dataset_dir":     os.getenv("DATASET_DIR", "/data/telecom"),
        "dataset_sources": dataset.list_sources(),
    }


# ── Metrics ───────────────────────────────────────────────────────────
@app.get("/metrics")
def get_metrics(
    cell_id: str | None = Query(None),
    last_n:  int        = Query(10, ge=1, le=60),
):
    """Return recent KPI history. Optionally filter by cell_id."""
    if cell_id:
        if cell_id not in state.cells:
            raise HTTPException(404, f"Cell {cell_id} not found")
        return {"cell_id": cell_id, "kpis": state.get_kpi_history(cell_id, last_n)}
    return {"kpis": state.get_all_latest_kpis()}


# ── Topology ──────────────────────────────────────────────────────────
@app.get("/topology")
def get_topology(entity_id: str | None = Query(None)):
    return state.get_topology(entity_id)


# ── Events ────────────────────────────────────────────────────────────
@app.get("/events")
def get_events(
    entity_id: str | None = Query(None),
    limit:     int        = Query(50, ge=1, le=500),
):
    if entity_id:
        return {"events": events.get_events_for_entity(entity_id, limit)}
    return {"events": events.get_recent_events(limit)}


# ── What-if simulation ────────────────────────────────────────────────
class WhatIfRequest(BaseModel):
    action_plan:   dict
    horizon_ticks: int = 120


@app.post("/whatif/run")
def run_whatif(req: WhatIfRequest):
    report = whatif.run(state, req.action_plan, req.horizon_ticks)
    return report


# ── Actions ───────────────────────────────────────────────────────────
class SlicePolicyRequest(BaseModel):
    slice_id:   str
    min_bw_pct: float | None = None
    max_bw_pct: float | None = None
    priority:   int   | None = None


@app.post("/actions/apply_slice_policy")
def apply_slice_policy(req: SlicePolicyRequest):
    if req.slice_id not in state.slices:
        raise HTTPException(404, f"Slice {req.slice_id} not found")
    sl = state.slices[req.slice_id]
    if req.min_bw_pct is not None:
        sl.min_bw_pct = req.min_bw_pct
    if req.max_bw_pct is not None:
        sl.max_bw_pct = req.max_bw_pct
    if req.priority is not None:
        sl.priority = req.priority
    change_id = f"CHG-{uuid.uuid4().hex[:6].upper()}"
    state.change_records[change_id] = {
        "type":       "slice_policy",
        "slice_id":   req.slice_id,
        "params":     req.model_dump(),
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
    cell = state.cells[req.cell_id]
    if req.a3_offset is not None:
        cell.a3_offset = req.a3_offset
    if req.ttt_ms is not None:
        cell.ttt_ms = req.ttt_ms
    change_id = f"CHG-{uuid.uuid4().hex[:6].upper()}"
    state.change_records[change_id] = {
        "type":       "tune_handover",
        "cell_id":    req.cell_id,
        "params":     req.model_dump(),
        "sim_time_s": state.sim_time_s,
    }
    return {"change_id": change_id, "applied": req.model_dump()}


class EnergyModeRequest(BaseModel):
    cell_id: str
    mode:    str  # ACTIVE | SLEEP | SHUTDOWN


@app.post("/actions/enable_energy_saving")
def enable_energy_saving(req: EnergyModeRequest):
    if req.cell_id not in state.cells:
        raise HTTPException(404, f"Cell {req.cell_id} not found")
    try:
        mode = EnergyMode(req.mode)
    except ValueError:
        raise HTTPException(400, f"Invalid mode '{req.mode}'. Use ACTIVE, SLEEP, or SHUTDOWN")
    state.cells[req.cell_id].energy_mode = mode
    change_id = f"CHG-{uuid.uuid4().hex[:6].upper()}"
    state.change_records[change_id] = {
        "type":       "energy_mode",
        "cell_id":    req.cell_id,
        "mode":       req.mode,
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
    if t == "energy_mode":
        state.cells[record["cell_id"]].energy_mode = EnergyMode.ACTIVE
    elif t == "tune_handover":
        cell = state.cells.get(record["cell_id"])
        if cell:
            cell.a3_offset = 3.0
            cell.ttt_ms    = 40.0
    elif t == "slice_policy":
        pass  # full rollback implemented in AN-AGT-004 (Executor Agent)
    return {"rolled_back": req.change_id, "record": record}


# ── Fault injection ────────────────────────────────────────────────────
class FaultRequest(BaseModel):
    scenario: str
    params:   dict = {}


@app.post("/fault/inject")
def inject_fault(req: FaultRequest):
    fn = getattr(FaultInjector, req.scenario, None)
    if fn is None:
        raise HTTPException(
            400,
            f"Unknown scenario '{req.scenario}'. "
            "Available: evening_congestion, backhaul_degradation, "
            "mobility_storm, policy_misconfiguration, energy_saving_failure"
        )
    result = fn(state, **req.params)
    return {"injected": result}


@app.post("/fault/restore")
def restore_fault(req: FaultRequest):
    fn = getattr(FaultInjector, f"restore_{req.scenario}", None)
    if fn is None:
        raise HTTPException(
            400,
            f"No restore method for '{req.scenario}'. "
            "Available: backhaul, energy_mode, slice_priorities, handover_params"
        )
    result = fn(state, **req.params)
    return {"restored": result}


# ── Snapshot ──────────────────────────────────────────────────────────
@app.get("/snapshot")
def snapshot():
    return state.snapshot()