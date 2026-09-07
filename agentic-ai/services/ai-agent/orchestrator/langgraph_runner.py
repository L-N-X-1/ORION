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
import re
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Dict, List

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from langchain_core.messages import HumanMessage, SystemMessage  # type: ignore[import-untyped]
from langchain_ollama import ChatOllama  # type: ignore[import-untyped]
from langgraph.types import Command

from orchestrator.graph import pipeline
from shared.event_bus import EventBus, poll_kpis_from_twin
from shared.memory_store import (
    claim_entity_processing,
    find_active_incident_by_entity,
    release_entity_processing,
    store_kpi,
)
from shared.redis_client import get_value
from shared.schemas import ApprovalDecisionRequest, IncidentType, KPISnapshot, NetworkEvent

log = logging.getLogger(__name__)
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

# ── Anomaly detection setup ───────────────────────────────────────────────────

# All cell IDs in the 3×4 topology
_ALL_CELLS = [f"C{r}{c}" for r in range(3) for c in range(4)]

_ANOMALY_INTERVAL_S = int(os.getenv("ANOMALY_INTERVAL_S", "30"))

_anomaly_llm = ChatOllama(
    model=os.getenv("OLLAMA_MODEL", "llama3.2"),
    temperature=0,
    base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
)

_ANOMALY_SYSTEM_PROMPT = """\
You are a 5G network anomaly detector.
Analyze the last few KPI ticks for a single cell and decide if the trend is
likely to breach alerting thresholds within the next 2-3 ticks.

Respond with valid JSON only:
{"anomaly": true/false, "reason": "<one sentence>"}

Set anomaly=true only when you see a clear rising trend in PRB, sustained
latency increase, growing HO failure rate, or SLA violations starting.
"""


async def _llm_anomaly_check(cell_id: str, kpis: List[KPISnapshot]) -> bool:
    """Returns True if LLM detects an early anomaly trend. False on failure."""
    ticks = [
        {
            "tick": i + 1,
            "prb": round(k.prb_utilization, 1),
            "latency_ms": round(k.latency_p95_ms, 1),
            "ho_fail": round(k.ho_fail_rate, 3),
            "sla_violation": k.sla_violation,
        }
        for i, k in enumerate(kpis)
    ]
    prompt = (
        f"Cell: {cell_id}\n"
        f"KPI ticks (oldest→newest):\n{json.dumps(ticks, indent=2)}\n\n"
        "Is this trend anomalous? Respond with JSON only:"
    )
    try:
        resp = await _anomaly_llm.ainvoke(
            [SystemMessage(content=_ANOMALY_SYSTEM_PROMPT), HumanMessage(content=prompt)]
        )
        match = re.search(r"\{[^{}]*\}", resp.content, re.DOTALL)
        if match:
            parsed = json.loads(match.group())
            result = bool(parsed.get("anomaly", False))
            if result:
                log.info(
                    "Anomaly LLM flagged %s: %s", cell_id, parsed.get("reason", "")
                )
            return result
    except Exception as exc:
        log.debug("Anomaly LLM check failed for %s: %s", cell_id, exc)
    return False


async def _check_anomalies() -> None:
    """Check all cells for early-warning trends; fire synthetic events if found."""
    for cell_id in _ALL_CELLS:
        try:
            from shared.memory_store import get_recent_kpis

            kpis = await get_recent_kpis(cell_id, n=5)
            if len(kpis) < 3:
                continue

            latest_prb = kpis[-1].prb_utilization
            # Skip cells already at threshold (event_generator handles those)
            # or too low to be interesting
            if latest_prb >= 92 or latest_prb < 65:
                continue

            # Skip if active CONGESTION incident already open for this cell
            active = await find_active_incident_by_entity(
                cell_id, IncidentType.CONGESTION.value, window_seconds=300
            )
            if active:
                continue

            # ── LLM check (primary) ──────────────────────────────────────────
            flagged = await _llm_anomaly_check(cell_id, kpis)

            # ── Deterministic fallback: PRB > 78% and strictly rising 3+ ticks
            if not flagged:
                prb_vals = [k.prb_utilization for k in kpis[-3:]]
                if (
                    prb_vals[-1] > 78
                    and all(prb_vals[i] < prb_vals[i + 1] for i in range(len(prb_vals) - 1))
                ):
                    flagged = True
                    log.info(
                        "Anomaly deterministic fallback flagged %s (PRB=%.1f%%, rising)",
                        cell_id, latest_prb,
                    )

            if not flagged:
                continue

            # Claim processing slot — prevents race with Kafka events
            claimed = await claim_entity_processing(
                cell_id, IncidentType.CONGESTION.value
            )
            if not claimed:
                continue

            event_id = f"anomaly-{uuid.uuid4().hex[:8]}"
            event = NetworkEvent(
                event_id=event_id,
                correlation_id=event_id,
                event_type="CONGESTION",
                entity_id=cell_id,
                severity_hint="medium",
                sim_time_s=0.0,
                timestamp=datetime.now(timezone.utc),
                extra={"source": "anomaly_detector", "prb": latest_prb},
            )
            log.info(
                "Anomaly detector firing early-warning event for %s (PRB=%.1f%%)",
                cell_id, latest_prb,
            )
            # Release claim before pipeline runs — triage will re-claim via its own guard
            await release_entity_processing(cell_id, IncidentType.CONGESTION.value)
            asyncio.create_task(handle_network_event(event))

        except Exception as exc:
            log.warning("Anomaly check error for %s: %s", cell_id, exc)


async def _anomaly_detection_loop() -> None:
    """Background loop: scan KPI trends every ANOMALY_INTERVAL_S seconds."""
    await asyncio.sleep(45)  # wait for KPI poller to populate memory store
    log.info("Anomaly detection loop started (interval=%ds)", _ANOMALY_INTERVAL_S)
    while True:
        await asyncio.sleep(_ANOMALY_INTERVAL_S)
        try:
            await _check_anomalies()
        except Exception as exc:
            log.warning("Anomaly detection loop error: %s", exc)


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
    asyncio.create_task(_anomaly_detection_loop())
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


@app.get("/approvals/pending", summary="List all pending human approvals")
async def list_pending_approvals() -> Dict[str, Any]:
    from shared.redis_client import scan_keys
    keys = await scan_keys("approval:*")
    pending = []
    for key in keys:
        raw = await get_value(key)
        if raw:
            try:
                pending.append(json.loads(raw))
            except json.JSONDecodeError:
                pass
    pending.sort(key=lambda x: x.get("requested_at", ""), reverse=True)
    return {"pending": pending, "count": len(pending)}


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