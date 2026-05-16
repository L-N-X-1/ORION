"""
triage/agent.py
---------------
NOC Triage Agent — LangGraph node.

Role  : Detect
Goal  : Transform a raw NetworkEvent into a clean IncidentRecord with
        classification, scope, severity, and an evidence bundle.

The node is designed to be registered in the LangGraph StateGraph as:

    graph.add_node("triage", triage_node)

It receives a PipelineState, reads raw_event, and writes incident_record
back into the state.

LLM usage
---------
The agent uses an LLM (Claude / OpenAI) for two optional enrichment steps:
  1. Natural-language summary of the incident (summary field).
  2. Refinement of the classifier result when the event type is UNKNOWN.

All hard logic (classification, severity, scope expansion) is rule-based
so the agent works even if the LLM is unavailable.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime
from typing import Any, Dict

from langchain_ollama import ChatOllama
from langchain_core.messages import HumanMessage, SystemMessage

from shared.memory_store import find_incident_by_correlation, store_incident
from shared.schemas import (
    IncidentType,
    NetworkEvent,
    PipelineState,
    Severity,
)
from shared.tools import create_ticket
from triage.classifier import classify_from_event, classify_from_kpis, compute_severity
from triage.evidence import build_evidence_window, expand_scope
from triage.incident_record import enrich_incident, new_incident

log = logging.getLogger(__name__)

# ── LLM setup ────────────────────────────────────────────────────────────────

_llm = ChatOllama(
    model=os.getenv("OLLAMA_MODEL", "llama3.3"),
    temperature=0,
    base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
)

SYSTEM_PROMPT = """You are the NOC Triage Agent for AURA-NET, an autonomous 5G network
operations platform.  Your job is to produce a concise, operator-readable summary
of a network incident based on the structured data provided.

Rules:
- Be factual and specific.  Mention affected cells, KPI values, and severity.
- Keep the summary under 120 words.
- Do not recommend actions (that is the Planner Agent's job).
- If data is insufficient, say so briefly.
"""


async def _generate_summary(
    event: NetworkEvent,
    incident_type: IncidentType,
    severity: Severity,
    affected_entities: list,
    evidence_snippet: str,
) -> str:
    """Call the LLM to produce a human-readable incident summary."""
    prompt = (
        f"Incident type: {incident_type.value}\n"
        f"Severity: {severity.value}\n"
        f"Affected entities: {', '.join(affected_entities)}\n"
        f"Trigger event: {event.event_type} on {event.entity_id}\n"
        f"KPI evidence (latest tick):\n{evidence_snippet}\n\n"
        "Write the incident summary:"
    )
    try:
        response = await _llm.ainvoke(
            [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=prompt)]
        )
        log.info("═" * 60)
        log.info("LLM CALLED — model: %s", _llm.model)
        log.info("LLM RESPONSE [%d chars]:", len(response.content))
        log.info("%s", response.content)
        log.info("═" * 60)
        return response.content.strip()
    except Exception as exc:
        log.warning("LLM call FAILED: %s", exc)
        return (
            f"{incident_type.value.replace('_', ' ').title()} detected on "
            f"{', '.join(affected_entities)}. Severity: {severity.value}."
        )


# ── Main LangGraph node ───────────────────────────────────────────────────────

async def triage_node(state: Dict[str, Any]) -> Dict[str, Any]:
    """
    LangGraph node entry point.

    Accepts state as a plain dict (LangGraph passes state that way) and
    returns an updated dict with 'incident_record' populated.
    """
    pipeline = PipelineState(**state)

    if pipeline.raw_event is None:
        log.error("triage_node called with no raw_event in state")
        pipeline.pipeline_halted = True
        pipeline.halt_reason = "No raw_event provided to Triage Agent"
        return pipeline.model_dump()

    event: NetworkEvent = pipeline.raw_event
    log.info("Triage Agent processing event %s [%s]", event.event_id, event.event_type)

    # ── Step 1: Deduplication ─────────────────────────────────────────────────
    existing = await find_incident_by_correlation(event.correlation_id)
    if existing:
        log.info(
            "Duplicate event for correlation_id %s — enriching INC %s",
            event.correlation_id,
            existing.incident_id,
        )
        evidence, _ = await build_evidence_window(event.entity_id)
        enriched = enrich_incident(existing, [event.entity_id], evidence)
        await store_incident(enriched)
        pipeline.incident_record = enriched
        return pipeline.model_dump()

    # ── Step 2: Classify incident type ───────────────────────────────────────
    incident_type = classify_from_event(event)

    # ── Step 3: Gather evidence window ───────────────────────────────────────
    evidence_kpis, baseline = await build_evidence_window(event.entity_id)

    # Refine classification from KPIs if the event type was not recognised
    if incident_type == IncidentType.UNKNOWN and evidence_kpis:
        incident_type = classify_from_kpis(evidence_kpis)
        log.debug("KPI-based classification: %s", incident_type)

    # ── Step 4: Set severity ─────────────────────────────────────────────────
    severity = compute_severity(incident_type, evidence_kpis, event.severity_hint)

    # ── Step 5: Expand scope (neighbours + backhaul peers) ───────────────────
    correlated_entities = await expand_scope(event.entity_id)
    affected_entities = list({event.entity_id, *correlated_entities})

    # ── Step 6: Build evidence snippet for the LLM ───────────────────────────
    if evidence_kpis:
        latest = evidence_kpis[-1]
        evidence_snippet = (
            f"  PRB util: {latest.prb_utilization:.1f}%\n"
            f"  Latency p95: {latest.latency_p95_ms:.1f} ms\n"
            f"  Throughput: {latest.throughput_mbps:.1f} Mbps\n"
            f"  SINR: {latest.sinr_db:.1f} dB\n"
            f"  HO fail rate: {latest.ho_fail_rate:.3f}\n"
            f"  SLA violation: {latest.sla_violation}\n"
        )
    else:
        evidence_snippet = "  No KPI data available yet."

    # ── Step 7: Generate LLM summary ─────────────────────────────────────────
    summary = await _generate_summary(
        event, incident_type, severity, affected_entities, evidence_snippet
    )

    # ── Step 8: Create IncidentRecord ─────────────────────────────────────────
    record = new_incident(
        event=event,
        incident_type=incident_type,
        severity=severity,
        affected_entities=affected_entities,
        evidence_kpis=evidence_kpis,
        pre_incident_baseline=baseline,
        candidate_correlated_entities=correlated_entities,
        summary=summary,
    )

    # ── Step 9: Open ticket for Critical incidents ────────────────────────────
    if severity.value == "critical":
        ticket_id = await create_ticket(
            summary=summary,
            severity=severity.value,
            incident_id=record.incident_id,
        )
        if ticket_id:
            record = record.model_copy(update={"ticket_id": ticket_id})
            log.info("Opened ticket %s for incident %s", ticket_id, record.incident_id)

    # ── Step 10: Persist and hand off ────────────────────────────────────────
    await store_incident(record)
    log.info(
        "IncidentRecord %s created [%s / %s] — %d affected entities",
        record.incident_id,
        incident_type.value,
        severity.value,
        len(affected_entities),
    )

    pipeline.incident_record = record
    return pipeline.model_dump()

