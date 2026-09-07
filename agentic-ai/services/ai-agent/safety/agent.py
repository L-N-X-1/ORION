"""Safety LangGraph node — evaluates action_plan against deterministic rules,
then runs an optional LLM contextual review when rules return ALLOW."""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Dict

from langchain_core.messages import HumanMessage, SystemMessage  # type: ignore[import-untyped]
from langchain_ollama import ChatOllama  # type: ignore[import-untyped]

from shared.schemas import PipelineState, PolicyDecision, PolicyDecisionRecord
from safety.policy_engine import evaluate
from safety.blast_radius import compute_blast_radius
from safety.rate_limiter import recent_change_count

log = logging.getLogger(__name__)

_llm = ChatOllama(
    model=os.getenv("OLLAMA_MODEL", "llama3.2"),
    temperature=0,
    base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
)

_SAFETY_SYSTEM_PROMPT = """\
You are the AURA-NET Safety Review Agent.  The deterministic policy engine
already approved this action.  Your job is a secondary contextual check.

Respond with valid JSON only:
{
  "escalate": true/false,
  "concern": "<one sentence if escalating, else empty string>",
  "confidence": <0.0-1.0>
}

Escalate (set escalate=true) ONLY if you identify a concrete risk that the
rules missed — e.g., action targets wrong entity, KPI evidence contradicts
the chosen action type, or blast radius looks underestimated.
When in doubt, do NOT escalate (rules are conservative enough).
"""


async def _llm_safety_review(
    action_plan: Dict[str, Any],
    incident: Dict[str, Any],
    base_decision: PolicyDecisionRecord,
    blast: int,
) -> PolicyDecisionRecord:
    """
    Secondary LLM check when policy_engine returns ALLOW.
    Can escalate to ALLOW_WITH_APPROVAL if LLM confidence >= 0.7.
    Falls back to original decision on any failure.
    """
    sel = action_plan.get("selected_action", {})
    params = {p["name"]: p["value"] for p in sel.get("parameters", [])}
    prompt = (
        f"Action type: {sel.get('action_type')}\n"
        f"Target entity: {sel.get('target_entity')}\n"
        f"Parameters: {json.dumps(params)}\n"
        f"Blast radius: {blast} cells\n"
        f"Incident type: {incident.get('incident_type')}\n"
        f"Incident severity: {incident.get('severity')}\n"
        f"Affected entities: {incident.get('affected_entities')}\n"
        f"Rationale from planner: {action_plan.get('rationale', 'n/a')}\n\n"
        "Is there a concrete risk the rules missed? Respond with JSON only:"
    )

    try:
        resp = await _llm.ainvoke(
            [SystemMessage(content=_SAFETY_SYSTEM_PROMPT), HumanMessage(content=prompt)]
        )
        log.info("LLM safety review raw: %s", resp.content[:300])
        match = re.search(r"\{[^{}]*\}", resp.content, re.DOTALL)
        if match:
            parsed = json.loads(match.group())
            escalate = bool(parsed.get("escalate", False))
            concern = str(parsed.get("concern", ""))
            confidence = float(parsed.get("confidence", 0.0))
            if escalate and confidence >= 0.7:
                log.info("LLM safety escalation (confidence=%.2f): %s", confidence, concern)
                return PolicyDecisionRecord(
                    incident_id=base_decision.incident_id,
                    decision=PolicyDecision.ALLOW_WITH_APPROVAL,
                    reasons=[f"LLM safety review: {concern}"],
                    evaluated_rules=base_decision.evaluated_rules + ["LLM-SEC"],
                    blast_radius=blast,
                )
    except Exception as exc:
        log.warning("LLM safety review failed (%s) — keeping ALLOW", exc)

    return base_decision


async def safety_node(state: Dict[str, Any]) -> Dict[str, Any]:
    pipeline = PipelineState(**state)
    if pipeline.action_plan is None or pipeline.incident_record is None:
        log.error("safety_node called without action_plan or incident_record")
        pipeline.pipeline_halted = True
        pipeline.halt_reason = "Missing inputs for Safety Agent"
        return pipeline.model_dump()

    action_plan: Dict[str, Any] = pipeline.action_plan.model_dump(mode="json")
    incident: Dict[str, Any] = pipeline.incident_record.model_dump(mode="json")

    blast = compute_blast_radius(action_plan)
    recent = await recent_change_count()
    whatif_confidences = [
        v.get("score", {}).get("confidence", 100)
        for v in (action_plan.get("delta_forecast", {}) or {}).values()
    ]

    a_type = action_plan.get("selected_action", {}).get("action_type")
    log.info(
        "safety_node: incident=%s action_type=%s blast=%d recent_changes=%d whatif=%s",
        incident.get("incident_id"), a_type, blast, recent, whatif_confidences,
    )

    # ── Tier 1: deterministic policy rules (always run, always authoritative) ──
    decision: PolicyDecisionRecord = evaluate(action_plan, incident, recent, blast, whatif_confidences)
    log.info("safety_node: deterministic decision=%s reasons=%s", decision.decision.value, decision.reasons)

    # ── Tier 2: LLM contextual review — only when rules pass cleanly ──────────
    # DENY and ALLOW_WITH_APPROVAL are already flagged; LLM only secondary-checks ALLOW.
    if decision.decision == PolicyDecision.ALLOW:
        decision = await _llm_safety_review(action_plan, incident, decision, blast)
        log.info("safety_node: final decision after LLM review=%s", decision.decision.value)

    pipeline.policy_decision = decision
    return pipeline.model_dump()
