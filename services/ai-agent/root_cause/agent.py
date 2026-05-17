"""
root_cause/agent.py
-------------------
Root Cause Agent — LangGraph node.

Role  : Analyze
Goal  : Explain WHY the incident happened by correlating KPIs, events, and
        topology; produce a HypothesisTree with confidence scores and a full
        RCAReport.

The node is registered in the LangGraph StateGraph as:

    graph.add_node("root_cause", root_cause_node)

It receives a PipelineState with a populated incident_record and writes
rca_report back into the state.

LLM usage
---------
The LLM is used for one step:
  - Generating the natural-language RCA summary that operators read.

All analytical steps (KPI correlation, pattern detection, hypothesis
building, topology traversal) are deterministic Python.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_ollama import ChatOllama

from root_cause.correlator import correlation_matrix, detect_pattern
from root_cause.hypothesis_tree import build_hypothesis_tree
from root_cause.topology_graph import (
    compute_structural_impact,
    find_synchronised_degradation,
    get_backhaul_peers,
    get_neighbours,
)
from shared.memory_store import get_recent_kpis
from shared.schemas import (
    IncidentRecord,
    IncidentType,
    KPISnapshot,
    PipelineState,
    RCAReport,
)
from shared.tools import get_topology

log = logging.getLogger(__name__)

# ── LLM setup ────────────────────────────────────────────────────────────────

_llm = ChatOllama(
    model=os.getenv("OLLAMA_MODEL", "llama3.2"),
    temperature=0,
    base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
)

SYSTEM_PROMPT = """You are the Root Cause Analysis Agent for AURA-NET, an autonomous 5G
network operations platform.

Your job is to produce a concise, technically precise RCA summary for NOC operators.

Guidelines:
- Lead with the most likely root cause (highest-confidence hypothesis).
- Reference specific KPI values and cell IDs where relevant.
- Describe the causal chain: what triggered what.
- Keep the summary under 200 words.
- Do not recommend remediation actions (that is the Planner Agent's role).
- State the confidence level (e.g., "high confidence", "medium confidence").
"""


async def _generate_rca_summary(
    incident: IncidentRecord,
    pattern: Dict[str, Any],
    dominant_hypothesis: Any,
    structural_info: Dict[str, Any],
) -> str:
    """Call the LLM to produce a human-readable RCA summary."""
    prompt = (
        f"Incident ID: {incident.incident_id}\n"
        f"Incident type (triage): {incident.incident_type.value}\n"
        f"Affected entities: {', '.join(incident.affected_entities)}\n\n"
        f"Dominant pattern detected:\n"
        f"  Congestion cells: {pattern['congestion_cells']}\n"
        f"  Backhaul cells:   {pattern['backhaul_cells']}\n"
        f"  Mobility cells:   {pattern['mobility_storm_cells']}\n"
        f"  SINR degraded:    {pattern['sinr_degraded_cells']}\n"
        f"  SLA violated:     {pattern['sla_violation_cells']}\n\n"
        f"Dominant hypothesis (rank 1):\n"
        f"  Label:      {dominant_hypothesis.label}\n"
        f"  Confidence: {dominant_hypothesis.confidence}\n"
        f"  Description: {dominant_hypothesis.description}\n\n"
        f"Structural impact summary:\n{structural_info}\n\n"
        "Write the RCA summary:"
    )
    try:
        response = await _llm.ainvoke(
            [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=prompt)]
        )
        return response.content.strip()
    except Exception as exc:
        log.warning("LLM RCA summary generation failed: %s", exc)
        return (
            f"Root cause analysis for {incident.incident_id}: "
            f"{dominant_hypothesis.description} "
            f"(confidence: {dominant_hypothesis.confidence:.0%})"
        )


# ── Main LangGraph node ───────────────────────────────────────────────────────

async def root_cause_node(state: Dict[str, Any]) -> Dict[str, Any]:
    """
    LangGraph node entry point.

    Reads incident_record from state, performs full RCA, and writes
    rca_report back into the state.
    """
    pipeline = PipelineState(**state)

    # ── Guard: no incident record ─────────────────────────────────────────────
    if pipeline.incident_record is None:
        log.error("root_cause_node called without an IncidentRecord in state")
        pipeline.pipeline_halted = True
        pipeline.halt_reason = "No IncidentRecord provided to Root Cause Agent"
        return pipeline.model_dump()

    incident: IncidentRecord = pipeline.incident_record

    # ── Guard: skip re-run if RCA already exists for this incident ────────────
    if pipeline.rca_report is not None:
        existing_incident_id = (
            pipeline.rca_report.get("incident_id")
            if isinstance(pipeline.rca_report, dict)
            else pipeline.rca_report.incident_id
        )
        if existing_incident_id == incident.incident_id:
            log.info(
                "Skipping RCA re-run — report already exists for %s",
                incident.incident_id,
            )
            return pipeline.model_dump()

    log.info(
        "Root Cause Agent analysing incident %s [%s]",
        incident.incident_id,
        incident.incident_type.value,
    )

    # ── Step 1: Reconstruct KPI history for all affected entities ─────────────
    kpis_by_entity: Dict[str, List[KPISnapshot]] = {}
    for eid in incident.affected_entities:
        snaps = await get_recent_kpis(eid, n=15)
        if snaps:
            kpis_by_entity[eid] = snaps
        else:
            # Fall back to the evidence bundle attached by the Triage Agent
            kpis_by_entity[eid] = [
                s for s in incident.evidence_kpis if s.entity_id == eid
            ]

    # ── Step 2: Correlate KPIs across scope ───────────────────────────────────
    pattern = detect_pattern(kpis_by_entity)
    log.debug("Pattern detection result: %s", pattern)

    corr_matrix = correlation_matrix(kpis_by_entity)

    # ── Step 3: Topology-based dependency check ───────────────────────────────
    primary_entity = incident.affected_entities[0]
    primary_topo = await get_topology(primary_entity)

    backhaul_peers = await get_backhaul_peers(primary_entity)
    synchronised = await find_synchronised_degradation(
        primary_entity, kpis_by_entity, kpi_field="prb_utilization"
    )

    log.debug(
        "Topology: neighbours=%s  backhaul_peers=%s  synchronised=%s",
        primary_topo.get("neighbours"),
        backhaul_peers,
        synchronised,
    )

    # ── Step 4: Build HypothesisTree ──────────────────────────────────────────
    hypothesis_tree = build_hypothesis_tree(
        pattern=pattern,
        kpis_by_entity=kpis_by_entity,
        topology=primary_topo,
    )
    dominant = hypothesis_tree.dominant_root
    log.info(
        "Dominant hypothesis: %s (confidence=%.2f)",
        dominant.label,
        dominant.confidence,
    )

    # ── Step 5: Structural impact summary ─────────────────────────────────────
    structural_info = await compute_structural_impact(incident.affected_entities)

    # ── Step 6: Build correlated KPI snapshot dict for the report ────────────
    correlated_kpis: Dict[str, Any] = {}
    for eid, snaps in kpis_by_entity.items():
        if snaps:
            latest = snaps[-1]
            correlated_kpis[eid] = {
                "prb_utilization": latest.prb_utilization,
                "latency_p95_ms":  latest.latency_p95_ms,
                "throughput_mbps": latest.throughput_mbps,
                "sinr_db":         latest.sinr_db,
                "ho_fail_rate":    latest.ho_fail_rate,
                "packet_loss_pct": latest.packet_loss_pct,
                "sla_violation":   latest.sla_violation,
                "energy_mode":     latest.energy_mode,
            }

    # ── Step 7: Generate LLM summary ─────────────────────────────────────────
    rca_summary = await _generate_rca_summary(
        incident, pattern, dominant, structural_info
    )

    # ── Step 8: Determine remediation levers ─────────────────────────────────
    levers: List[str] = []
    seen_levers: set = set()
    for hyp in hypothesis_tree.hypotheses:
        if hyp.recommended_lever and hyp.recommended_lever not in seen_levers:
            levers.append(hyp.recommended_lever)
            seen_levers.add(hyp.recommended_lever)

    # ── Step 9: Assemble and return RCAReport ─────────────────────────────────
    rca_report = RCAReport(
        incident_id=incident.incident_id,
        root_cause_classification=_map_label_to_type(dominant.label),
        affected_nodes=incident.affected_entities,
        correlated_kpis=correlated_kpis,
        hypothesis_tree=hypothesis_tree,
        remediation_levers=levers,
        summary=rca_summary,
    )

    log.info(
        "RCA complete for %s — root cause: %s (confidence=%.2f)",
        incident.incident_id,
        dominant.label,
        dominant.confidence,
    )

    pipeline.rca_report = rca_report
    return pipeline.model_dump()


# ── Helper ────────────────────────────────────────────────────────────────────

def _map_label_to_type(label: str) -> IncidentType:
    """Map a hypothesis label string to the closest IncidentType."""
    mapping = {
        "traffic_burst_slice_too_narrow": IncidentType.CONGESTION,
        "slice_policy_misconfiguration":  IncidentType.MISCONFIGURATION,
        "backhaul_capacity_reduction":    IncidentType.BACKHAUL_DEGRADATION,
        "bad_handover_parameters":        IncidentType.MOBILITY_STORM,
        "cell_energy_saving_failure":     IncidentType.OUTAGE,
    }
    return mapping.get(label, IncidentType.UNKNOWN)