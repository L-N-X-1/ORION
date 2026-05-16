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

from orchestrator.graph import pipeline
from shared.event_bus import EventBus, poll_kpis_from_twin
from shared.memory_store import store_kpi
from shared.schemas import KPISnapshot, NetworkEvent

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
    try:
        result = await pipeline.ainvoke(initial_state)
        _log_pipeline_result(result)
    except Exception as exc:
        log.error("Pipeline failed for event %s: %s", event.event_id, exc, exc_info=True)


def _log_pipeline_result(result: Dict[str, Any]) -> None:
    incident = result.get("incident_record")
    rca = result.get("rca_report")
    halted = result.get("pipeline_halted", False)
    halt_reason = result.get("halt_reason")

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
    try:
        result = await pipeline.ainvoke(initial_state)
    except Exception as exc:
        log.error("Pipeline error: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))

    serialisable = _serialise_state(result)
    return JSONResponse(content=serialisable)


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