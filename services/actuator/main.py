"""
AURA-NET Actuator Service
Ticket: AN-ACT-001
Applies network configuration changes to the Digital Twin.
"""
from __future__ import annotations

import os
import uuid
import json
from typing import Any, Dict

import asyncpg
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException

from pydantic import BaseModel

load_dotenv()

DATABASE_URL = os.getenv("POSTGRES_URL")
TWIN_URL = os.getenv("TWIN_URL", "http://digital-twin:8001")

app = FastAPI(title="AURA-NET Actuator", version="0.1.0")


class SlicePolicyRequest(BaseModel):
    incident_id: str
    slice_id: str
    min_bw_pct: float | None = None
    max_bw_pct: float | None = None
    priority: int | None = None


class HandoverRequest(BaseModel):
    incident_id: str
    cell_id: str
    a3_offset: float | None = None
    ttt_ms: float | None = None


class EnergyModeRequest(BaseModel):
    incident_id: str
    cell_id: str
    mode: str


class RollbackRequest(BaseModel):
    incident_id: str
    change_id: str


async def _pg_connect():
    return await asyncpg.connect(DATABASE_URL)


@app.on_event("startup")
async def startup():
    app.state._pg = await _pg_connect()
    app.state._client = httpx.AsyncClient(timeout=10.0)


@app.on_event("shutdown")
async def shutdown():
    await app.state._pg.close()
    await app.state._client.aclose()


def _gen_change_id() -> str:
    return f"CHG-{uuid.uuid4().hex[:8].upper()}"


async def _store_change_record(conn: asyncpg.Connection, record: Dict[str, Any]):
    await conn.execute(
        """
        INSERT INTO change_records(change_id, incident_id, action_type, parameters, pre_change_kpis, status, sim_time_s)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)
        """,
        record["change_id"],
        record["incident_id"],
        record["action_type"],
        json.dumps(record["parameters"]),
        json.dumps(record["pre_change_kpis"]),
        record.get("status", "applied"),
        record.get("sim_time_s"),
    )


async def _record_audit(conn: asyncpg.Connection, change_id: str, incident_id: str, action_type: str, parameters_hash: str, policy_decision: str, actor: str, pre_ref: str | None = None):
    await conn.execute(
        """
        INSERT INTO audit_log(change_id, incident_id, action_type, parameters_hash, policy_decision, actor, pre_change_kpi_ref)
        VALUES($1,$2,$3,$4,$5,$6,$7)
        """,
        change_id,
        incident_id,
        action_type,
        parameters_hash,
        policy_decision,
        actor,
        pre_ref,
    )


async def _take_pre_change_snapshot(client: httpx.AsyncClient, endpoint: str, params: Dict[str, Any]):
    # call digital twin /metrics to get latest kpis for target entity
    resp = await client.get(f"{TWIN_URL}/metrics", params=params)
    resp.raise_for_status()
    data = resp.json()
    return data.get("kpis", [])


@app.get("/health")
async def health():
    return {"status": "ok", "service": "actuator"}


@app.get("/metrics")
async def metrics():
    return {"status": "ok", "service": "actuator", "metrics": {}}


@app.post("/actions/apply_slice_policy")
async def apply_slice_policy(req: SlicePolicyRequest):
    client: httpx.AsyncClient = app.state._client
    change_id = _gen_change_id()
    # pre-change snapshot: metrics for all cells affected by the slice (approx: all cells)
    pre_kpis = await _take_pre_change_snapshot(client, "/metrics", {"last_n": 3})
    payload = {"slice_id": req.slice_id, "min_bw_pct": req.min_bw_pct, "max_bw_pct": req.max_bw_pct, "priority": req.priority}
    # forward to digital twin
    resp = await client.post(f"{TWIN_URL}/actions/apply_slice_policy", json=payload)
    resp.raise_for_status()
    body = resp.json()
    record = {
        "change_id": change_id,
        "incident_id": req.incident_id,
        "action_type": "apply_slice_policy",
        "parameters": {**payload, "_twin_change_id": body.get("change_id", "")},
        "pre_change_kpis": pre_kpis,
        "status": "applied",
        "sim_time_s": body.get("applied", {}).get("sim_time_s"),
    }
    await _store_change_record(app.state._pg, record)
    return {"change_id": change_id, "pre_change_kpis": pre_kpis}


@app.post("/actions/tune_handover")
async def tune_handover(req: HandoverRequest):
    client: httpx.AsyncClient = app.state._client
    change_id = _gen_change_id()
    pre_kpis = await _take_pre_change_snapshot(client, "/metrics", {"cell_id": req.cell_id, "last_n": 3})
    payload = {"cell_id": req.cell_id, "a3_offset": req.a3_offset, "ttt_ms": req.ttt_ms}
    resp = await client.post(f"{TWIN_URL}/actions/tune_handover", json=payload)
    resp.raise_for_status()
    body = resp.json()
    record = {
        "change_id": change_id,
        "incident_id": req.incident_id,
        "action_type": "tune_handover",
        "parameters": {**payload, "_twin_change_id": body.get("change_id", "")},
        "pre_change_kpis": pre_kpis,
        "status": "applied",
        "sim_time_s": body.get("applied", {}).get("sim_time_s"),
    }
    await _store_change_record(app.state._pg, record)
    return {"change_id": change_id, "pre_change_kpis": pre_kpis}


@app.post("/actions/enable_energy_saving")
async def enable_energy_saving(req: EnergyModeRequest):
    client: httpx.AsyncClient = app.state._client
    change_id = _gen_change_id()
    pre_kpis = await _take_pre_change_snapshot(client, "/metrics", {"cell_id": req.cell_id, "last_n": 3})
    payload = {"cell_id": req.cell_id, "mode": req.mode}
    resp = await client.post(f"{TWIN_URL}/actions/enable_energy_saving", json=payload)
    resp.raise_for_status()
    body = resp.json()
    record = {
        "change_id": change_id,
        "incident_id": req.incident_id,
        "action_type": "enable_energy_saving",
        "parameters": {**payload, "_twin_change_id": body.get("change_id", "")},
        "pre_change_kpis": pre_kpis,
        "status": "applied",
        "sim_time_s": body.get("sim_time_s"),
    }
    await _store_change_record(app.state._pg, record)
    return {"change_id": change_id, "pre_change_kpis": pre_kpis}


@app.get("/changes/{change_id}")
async def get_change(change_id: str):
    rec = await app.state._pg.fetchrow("SELECT * FROM change_records WHERE change_id=$1", change_id)
    if not rec:
        raise HTTPException(404, "change not found")
    return dict(rec)


@app.get("/changes/{change_id}/snapshot")
async def get_change_snapshot(change_id: str):
    rec = await app.state._pg.fetchrow("SELECT pre_change_kpis FROM change_records WHERE change_id=$1", change_id)
    if not rec:
        raise HTTPException(404, "change not found")
    return rec["pre_change_kpis"]


@app.post("/actions/rollback")
async def rollback(req: RollbackRequest):
    row = await app.state._pg.fetchrow("SELECT * FROM change_records WHERE change_id=$1", req.change_id)
    if not row:
        raise HTTPException(404, "change not found")
    params = json.loads(row["parameters"]) if isinstance(row["parameters"], str) else (row["parameters"] or {})
    twin_change_id = params.get("_twin_change_id") or req.change_id
    client: httpx.AsyncClient = app.state._client
    resp = await client.post(f"{TWIN_URL}/actions/rollback", json={"change_id": twin_change_id})
    resp.raise_for_status()
    await app.state._pg.execute("UPDATE change_records SET status='rolled_back' WHERE change_id=$1", req.change_id)
    return {"rolled_back": req.change_id}
