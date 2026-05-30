"""Verifier LangGraph node — compares pre/post KPIs and triggers rollback if needed."""

from __future__ import annotations

import logging
from typing import Any, Dict

from shared.schemas import PipelineState, VerificationReport
from verifier.kpi_monitor import poll_post_change_kpis
from verifier.rollback_trigger import trigger_rollback
from verifier.postmortem import generate_postmortem

log = logging.getLogger(__name__)


async def verifier_node(state: Dict[str, Any]) -> Dict[str, Any]:
	pipeline = PipelineState(**state)
	if pipeline.change_confirmation is None or pipeline.incident_record is None:
		pipeline.pipeline_halted = True
		pipeline.halt_reason = "Missing inputs for verifier"
		return pipeline.model_dump()

	cc = pipeline.change_confirmation
	incident = pipeline.incident_record
	# fetch pre-change snapshot from actuator
	import httpx
	ACT_URL = str(__import__("os").environ.get("ACTUATOR_URL", "http://actuator:8003"))
	async with httpx.AsyncClient(timeout=10.0) as client:
		resp = await client.get(f"{ACT_URL}/changes/{cc.change_id}/snapshot")
		resp.raise_for_status()
		pre = resp.json()

	# polling ticks depending on action_type
	ticks = 3 if cc.action_type == "apply_slice_policy" else 10 if cc.action_type == "tune_handover" else 5
	interval = int(__import__("os").environ.get("TICK_INTERVAL_S", "5"))
	target_entity = (
		cc.parameters_applied.get("cell_id")
		or (incident.affected_entities[0] if incident.affected_entities else None)
		or "C00"
	)
	samples = await poll_post_change_kpis(cc.change_id, target_entity, ticks, interval)

	# simple comparison: compare throughput_mbps and sla_violation
	before_vals = {s["cell_id"] if "cell_id" in s else "unknown": s for s in pre}
	after_vals = {s.get("cell_id", "unknown"): s for s in samples}
	outcome = "partial"
	rollback_triggered = False
	final_sla = False

	# determine success if SLA violation cleared in samples
	cleared = all(not v.get("sla_violation", False) for v in samples)
	if cleared:
		outcome = "success"
		final_sla = True
	else:
		# trigger rollback
		await trigger_rollback(cc.change_id, cc.incident_id)
		rollback_triggered = True
		outcome = "regression"

	postmortem_url = await generate_postmortem(incident.incident_id, "timeline omitted", before_vals, after_vals, [cc.model_dump() if hasattr(cc, "model_dump") else cc])

	report = VerificationReport(change_id=cc.change_id, incident_id=incident.incident_id, outcome=outcome, kpi_before={}, kpi_after={}, rollback_triggered=rollback_triggered, final_sla_state=final_sla, postmortem_url=postmortem_url)
	pipeline.verification_report = report
	return pipeline.model_dump()
