"""LLM-driven post-incident report generator."""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from langchain_core.messages import HumanMessage, SystemMessage  # type: ignore[import-untyped]
from langchain_ollama import ChatOllama  # type: ignore[import-untyped]

log = logging.getLogger(__name__)

_llm = ChatOllama(
    model=os.getenv("OLLAMA_MODEL", "llama3.2"),
    temperature=0,
    base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
)

_SYSTEM = """\
You are the AURA-NET Verifier Agent writing a post-incident report for NOC operators.

Write a clear, structured report covering:
1. INCIDENT SUMMARY — what happened, which cells were affected, severity, detection time.
2. ROOT CAUSE — dominant hypothesis with confidence, supporting KPI evidence.
3. ACTION TAKEN — what the system did to remediate, parameters used, who approved.
4. OUTCOME — KPI comparison (before vs after), whether SLA was restored.
5. LESSONS LEARNED — one or two concrete takeaways for improving future response.

Be specific. Use numbers. Keep the full report under 350 words.
Do NOT invent data that was not provided.
"""


def _build_prompt(
    incident: Dict[str, Any],
    rca: Optional[Dict[str, Any]],
    action_plan: Optional[Dict[str, Any]],
    change_confirmation: Dict[str, Any],
    kpi_before: Dict[str, Any],
    kpi_after: Dict[str, Any],
    outcome: str,
    rollback_triggered: bool,
) -> str:
    # ── Incident section ──────────────────────────────────────────────────────
    inc_id      = incident.get("incident_id", "unknown")
    inc_type    = incident.get("incident_type", "unknown")
    severity    = incident.get("severity", "unknown")
    affected    = ", ".join(incident.get("affected_entities", []))
    inc_summary = incident.get("summary", "No summary available.")
    created_at  = incident.get("created_at", "unknown")

    # ── RCA section ───────────────────────────────────────────────────────────
    rca_section = "No RCA data available."
    if rca:
        tree = rca.get("hypothesis_tree", {})
        dominant = tree.get("dominant_root", {}) if isinstance(tree, dict) else {}
        rca_section = (
            f"Dominant hypothesis: {dominant.get('label', 'unknown')} "
            f"(confidence={dominant.get('confidence', '?')})\n"
            f"Description: {dominant.get('description', '')}\n"
            f"Summary: {rca.get('summary', '')[:300]}"
        )

    # ── Action section ────────────────────────────────────────────────────────
    action_section = "No action plan data."
    if action_plan:
        sel   = action_plan.get("selected_action", {})
        params = {p["name"]: p["value"] for p in sel.get("parameters", [])} if isinstance(sel.get("parameters"), list) else {}
        rationale = action_plan.get("rationale", "n/a")
        action_section = (
            f"Action type: {sel.get('action_type', 'unknown')}\n"
            f"Target: {sel.get('target_entity', 'unknown')}\n"
            f"Parameters: {params}\n"
            f"Planner rationale: {rationale}\n"
            f"Approval source: {change_confirmation.get('approval_source', 'unknown')}"
        )

    # ── KPI comparison ────────────────────────────────────────────────────────
    kpi_lines = []
    all_keys = set(kpi_before) | set(kpi_after)
    for k in sorted(all_keys):
        b = kpi_before.get(k, "n/a")
        a = kpi_after.get(k, "n/a")
        kpi_lines.append(f"  {k}: {b} → {a}")
    kpi_section = "\n".join(kpi_lines) if kpi_lines else "  No KPI comparison available."

    outcome_note = (
        "ROLLBACK TRIGGERED — remediation failed, previous state restored."
        if rollback_triggered
        else f"OUTCOME: {outcome.upper()}"
    )

    return (
        f"Incident ID: {inc_id}\n"
        f"Type: {inc_type} | Severity: {severity}\n"
        f"Affected cells: {affected}\n"
        f"Detected at: {created_at}\n"
        f"Triage summary: {inc_summary[:200]}\n\n"
        f"ROOT CAUSE:\n{rca_section}\n\n"
        f"ACTION TAKEN:\n{action_section}\n\n"
        f"KPI COMPARISON (before → after):\n{kpi_section}\n\n"
        f"{outcome_note}\n\n"
        "Write the full post-incident report now:"
    )


def _fallback_report(
    incident: Dict[str, Any],
    action_plan: Optional[Dict[str, Any]],
    outcome: str,
    kpi_before: Dict[str, Any],
    kpi_after: Dict[str, Any],
    rollback_triggered: bool,
) -> str:
    inc_id   = incident.get("incident_id", "unknown")
    inc_type = incident.get("incident_type", "unknown")
    severity = incident.get("severity", "unknown")
    affected = ", ".join(incident.get("affected_entities", []))
    action   = ""
    if action_plan:
        sel    = action_plan.get("selected_action", {})
        action = f"{sel.get('action_type', 'unknown')} on {sel.get('target_entity', 'unknown')}"
    kpi_summary = "; ".join(f"{k}: {kpi_before.get(k,'?')}→{kpi_after.get(k,'?')}" for k in list(kpi_before)[:4])
    status  = "ROLLBACK" if rollback_triggered else outcome.upper()
    return (
        f"POST-INCIDENT REPORT — {inc_id}\n"
        f"Type: {inc_type} | Severity: {severity} | Cells: {affected}\n"
        f"Action: {action}\n"
        f"KPIs: {kpi_summary}\n"
        f"Status: {status}\n"
        "(LLM unavailable — fallback report)"
    )


async def generate_postmortem(
    incident: Dict[str, Any],
    rca: Optional[Dict[str, Any]],
    action_plan: Optional[Dict[str, Any]],
    change_confirmation: Dict[str, Any],
    kpi_before: Dict[str, Any],
    kpi_after: Dict[str, Any],
    outcome: str,
    rollback_triggered: bool,
) -> str:
    """Generate full post-incident report via LLM. Falls back to template on failure."""
    prompt = _build_prompt(
        incident, rca, action_plan, change_confirmation,
        kpi_before, kpi_after, outcome, rollback_triggered,
    )
    try:
        resp = await _llm.ainvoke(
            [SystemMessage(content=_SYSTEM), HumanMessage(content=prompt)]
        )
        report = resp.content.strip()
        log.info("Postmortem generated (%d chars) for %s", len(report), incident.get("incident_id"))
        return report
    except Exception as exc:
        log.warning("Postmortem LLM failed (%s) — using fallback", exc)
        return _fallback_report(incident, action_plan, outcome, kpi_before, kpi_after, rollback_triggered)
