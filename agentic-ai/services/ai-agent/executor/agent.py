"""Executor LangGraph node — applies approved actions via the Actuator."""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime
from typing import Any, Dict

from shared.schemas import PipelineState, ChangeConfirmation
from executor.idempotency import get_existing_change, store_change
from executor.action_runner import call_actuator
from executor.audit_log import write_audit

log = logging.getLogger(__name__)


async def executor_node(state: Dict[str, Any]) -> Dict[str, Any]:
	pipeline = PipelineState(**state)
	if pipeline.policy_decision is None or pipeline.action_plan is None:
		pipeline.pipeline_halted = True
		pipeline.halt_reason = "Missing policy decision or action plan"
		return pipeline.model_dump()

	decision = pipeline.policy_decision
	if getattr(decision, "decision", str(decision.get("decision") if isinstance(decision, dict) else "deny")).lower() != "allow":
		pipeline.pipeline_halted = True
		pipeline.halt_reason = "Policy decision did not allow execution"
		return pipeline.model_dump()

	inc_id = pipeline.incident_record.incident_id if pipeline.incident_record else ""
	existing = await get_existing_change(inc_id)
	if existing:
		log.info("Idempotent: returning existing change for incident %s", inc_id)
		pipeline.change_confirmation = ChangeConfirmation(**existing)
		return pipeline.model_dump()

	sel = pipeline.action_plan.selected_action
	action_payload = {"action_type": sel.action_type, "incident_id": inc_id, **{p.name: p.value for p in sel.parameters}}
	# call actuator
	resp = await call_actuator(action_payload)
	change_id = resp.get("change_id") or resp.get("applied", {}).get("change_id")
	pre_kpis = resp.get("pre_change_kpis") or resp.get("applied", {}).get("pre_change_kpis")

	# store idempotency
	change_record = {"change_id": change_id, "incident_id": inc_id, "action_type": sel.action_type, "parameters_applied": action_payload, "pre_change_kpis": pre_kpis, "executed_at": datetime.utcnow().isoformat()}
	await store_change(inc_id, change_record)

	# write audit
	phash = hashlib.sha256(str(action_payload).encode()).hexdigest()
	await write_audit(change_id, inc_id, sel.action_type, phash, pipeline.policy_decision.decision.value, "ai-executor", change_id)

	confirmation = ChangeConfirmation(change_id=change_id, incident_id=inc_id, action_type=sel.action_type, parameters_applied=action_payload, pre_change_kpi_ref=change_id, approval_source="ai", sim_time_s=resp.get("sim_time_s", 0.0))
	pipeline.change_confirmation = confirmation
	return pipeline.model_dump()
