"""Safety LangGraph node — evaluates action_plan against deterministic rules."""

from __future__ import annotations

import logging
from typing import Any, Dict

from shared.schemas import PipelineState, PolicyDecisionRecord
from safety.policy_engine import evaluate
from safety.blast_radius import compute_blast_radius
from safety.rate_limiter import recent_change_count

log = logging.getLogger(__name__)


async def safety_node(state: Dict[str, Any]) -> Dict[str, Any]:
	pipeline = PipelineState(**state)
	if pipeline.action_plan is None or pipeline.incident_record is None:
		log.error("safety_node called without action_plan or incident_record")
		pipeline.pipeline_halted = True
		pipeline.halt_reason = "Missing inputs for Safety Agent"
		return pipeline.model_dump()

	action_plan = pipeline.action_plan.model_dump(mode="json") if hasattr(pipeline.action_plan, "model_dump") else pipeline.action_plan
	incident = pipeline.incident_record.model_dump(mode="json") if hasattr(pipeline.incident_record, "model_dump") else pipeline.incident_record

	blast = compute_blast_radius(action_plan)
	recent = await recent_change_count()
	whatif_confidences = [v.get("score", {}).get("confidence", 100) for v in (action_plan.get("delta_forecast", {}) or {}).values()]

	a_type = action_plan.get("selected_action", {}).get("action_type")
	log.info(
		"safety_node: incident=%s action_type=%s blast=%d recent_changes=%d whatif=%s",
		incident.get("incident_id"), a_type, blast, recent, whatif_confidences,
	)

	decision: PolicyDecisionRecord = evaluate(action_plan, incident, recent, blast, whatif_confidences)
	log.info(
		"safety_node: decision=%s reasons=%s",
		decision.decision.value, decision.reasons,
	)
	pipeline.policy_decision = decision
	return pipeline.model_dump()
