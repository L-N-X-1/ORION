"""
orchestrator/langgraph_runner.py
---------------------------------
Entry point for the AI agent service.

Responsibilities
----------------
1. Subscribe to the Kafka event bus (aura.event.v1).
2. Poll KPIs directly from the digital-twin REST API (fallback for Kafka).
3. For every NetworkEvent received, run the compiled LangGraph pipeline.
4. Expose a POST /run endpoint so the pipeline can also be triggered
   directly (useful for testing and the API gateway).

The LangGraph pipeline runs asynchronously; each pipeline invocation is
isolated (no shared mutable state between runs).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, Dict

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from langgraph.types import Command

from orchestrator.graph import pipeline
from shared.event_bus import EventBus, poll_kpis_from_twin
from shared.memory_store import store_kpi
from shared.redis_client import get_value
from shared.schemas import ApprovalDecisionRequest, KPISnapshot, NetworkEvent

log = logging.getLogger(__name__)
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

# ── Event bus setup ───────────────────────────────────────────────────────────

bus = EventBus()
_bus_task: asyncio.Task | None = None


async def handle_network_event(event: NetworkEvent) -> None:
    """
    Callback invoked by the EventBus for every message on aura.event.v1.
    Runs the full LangGraph pipeline for this event.
    """
    log.info("Received event %s [%s] on %s", event.event_id, event.event_type, event.entity_id)
    initial_state: Dict[str, Any] = {"raw_event": event.model_dump(mode="json")}
    config = {"configurable": {"thread_id": event.event_id}}
    try:
        result = await pipeline.ainvoke(initial_state, config=config)
        _log_pipeline_result(result)
    except Exception as exc:
        log.error("Pipeline failed for event %s: %s", event.event_id, exc, exc_info=True)


def _log_pipeline_result(result: Dict[str, Any]) -> None:
    if result is None:
        log.warning("Pipeline returned None (checkpoint may have been lost)")
        return
    incident = result.get("incident_record")
    rca = result.get("rca_report")
    halted = result.get("pipeline_halted", False)
    halt_reason = result.get("halt_reason")

    if result.get("__interrupt__"):
        incident_id = (
            (result.get("policy_decision") or {}).get("incident_id", "unknown")
            if isinstance(result.get("policy_decision"), dict)
            else getattr(result.get("policy_decision"), "incident_id", "unknown")
        )
        log.info("Pipeline suspended — awaiting human approval for incident=%s", incident_id)
        return

    if halted:
        log.warning("Pipeline halted: %s", halt_reason)
        return

    if incident:
        inc_id = incident.get("incident_id") if isinstance(incident, dict) else incident.incident_id
        severity = incident.get("severity") if isinstance(incident, dict) else incident.severity
        log.info("Incident created: %s [severity=%s]", inc_id, severity)

    if rca:
        inc_id = rca.get("incident_id") if isinstance(rca, dict) else rca.incident_id
        root = (
            rca.get("root_cause_classification")
            if isinstance(rca, dict)
            else rca.root_cause_classification
        )
        log.info("RCA complete for %s — root cause: %s", inc_id, root)


# ── FastAPI app ───────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start the Kafka consumer and KPI poller on app startup."""
    global _bus_task
    bus.on_event(handle_network_event)
    _bus_task = asyncio.create_task(bus.start())
    asyncio.create_task(poll_kpis_from_twin())
    log.info("AI Agent service started — listening for network events")
    yield
    # Shutdown
    if _bus_task:
        await bus.stop()
        _bus_task.cancel()
        try:
            await _bus_task
        except asyncio.CancelledError:
            pass
    log.info("AI Agent service stopped")


app = FastAPI(
    title="AURA-NET AI Agent Service",
    version="1.0.0",
    description="Multi-agent autonomous network operations (Triage + RCA)",
    lifespan=lifespan,
)


# ── HTTP endpoints ────────────────────────────────────────────────────────────

@app.post("/run", summary="Trigger the agent pipeline with a synthetic event")
async def run_pipeline(event: NetworkEvent) -> JSONResponse:
    """
    Directly invoke the LangGraph pipeline with a NetworkEvent payload.
    Useful for testing without Kafka.
    """
    initial_state: Dict[str, Any] = {"raw_event": event.model_dump(mode="json")}
    config = {"configurable": {"thread_id": event.event_id}}
    try:
        result = await pipeline.ainvoke(initial_state, config=config)
    except Exception as exc:
        log.error("Pipeline error: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))

    if result.get("__interrupt__"):
        incident_id = (
            (result.get("policy_decision") or {}).get("incident_id", "unknown")
            if isinstance(result.get("policy_decision"), dict)
            else getattr(result.get("policy_decision"), "incident_id", "unknown")
        )
        return JSONResponse(
            status_code=202,
            content={
                "status": "awaiting_approval",
                "incident_id": incident_id,
                "approve_url": f"/approvals/{incident_id}/decision",
            },
        )
    serialisable = _serialise_state(result)
    return JSONResponse(content=serialisable)


@app.post(
    "/approvals/{incident_id}/decision",
    summary="Approve or reject a pending human-approval gate",
)
async def decide_approval(incident_id: str, body: ApprovalDecisionRequest) -> Dict[str, Any]:
    """
    Resume a pipeline suspended at the human_approval node.

    The pipeline paused because the Safety Agent returned ALLOW_WITH_APPROVAL.
    POST with {"decision": "approved", "approver": "ops@example.com"} to continue
    to the executor, or {"decision": "rejected"} to terminate the pipeline.
    """
    raw = await get_value(f"approval:{incident_id}")
    if not raw:
        raise HTTPException(
            status_code=404,
            detail=f"No pending approval found for incident {incident_id}. "
                   "It may have already been decided or expired (TTL 30 min).",
        )

    approval_data = json.loads(raw)
    thread_id = approval_data["thread_id"]

    log.info(
        "Operator decision received — incident=%s decision=%s approver=%s",
        incident_id,
        body.decision,
        body.approver,
    )

    try:
        result = await pipeline.ainvoke(
            Command(resume={"decision": body.decision, "approver": body.approver}),
            config={"configurable": {"thread_id": thread_id}},
        )
    except Exception as exc:
        err = str(exc)
        log.error("Failed to resume pipeline for incident=%s: %s", incident_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=err)

    if result is None:
        raise HTTPException(
            status_code=410,
            detail=f"Checkpoint for incident {incident_id} no longer exists "
                   "(service may have restarted — in-memory checkpoint was lost). "
                   "Re-trigger the incident.",
        )

    _log_pipeline_result(result)
    return {
        "status": "resumed",
        "incident_id": incident_id,
        "thread_id": thread_id,
        "decision": body.decision,
        "approver": body.approver,
        "pipeline_halted": result.get("pipeline_halted", False),
    }


@app.post("/seed-kpi", summary="Dev-only: seed a KPI snapshot into the memory store")
async def seed_kpi(snapshot: KPISnapshot) -> dict:
    """Seed a KPI snapshot directly — useful for testing without the digital-twin."""
    await store_kpi(snapshot)
    return {"status": "seeded", "entity_id": snapshot.entity_id}


@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/memory", summary="Dev-only: inspect the in-memory KPI store")
async def inspect_memory(entity_id: str = "C00", n: int = 5) -> dict:
    """
    Returns the last N KPI snapshots for an entity from the memory store.
    Use this to confirm the KPI poller is working before firing events.
    """
    from shared.memory_store import get_recent_kpis
    kpis = await get_recent_kpis(entity_id, n=n)
    return {
        "entity_id": entity_id,
        "count": len(kpis),
        "snapshots": [k.model_dump(mode="json") for k in kpis],
    }


# ── Serialisation helpers ─────────────────────────────────────────────────────

def _serialise_state(state: Dict[str, Any]) -> Dict[str, Any]:
    """Convert any Pydantic model values in the state dict to plain dicts."""
    out: Dict[str, Any] = {}
    for k, v in state.items():
        if hasattr(v, "model_dump"):
            out[k] = v.model_dump(mode="json")
        elif isinstance(v, dict):
            out[k] = _make_serialisable(v)
        else:
            out[k] = v
    return out


def _make_serialisable(obj: Any) -> Any:
    """Recursively convert datetime objects and other non-serialisable types."""
    if isinstance(obj, datetime):
        return obj.isoformat()
    elif isinstance(obj, dict):
        return {k: _make_serialisable(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_make_serialisable(i) for i in obj]
    return obj


# ── Entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        "orchestrator.langgraph_runner:app",
        host="0.0.0.0",
        port=int(os.getenv("AGENT_PORT", "8003")),
        reload=False,
    )