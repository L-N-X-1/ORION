"""AURA-NET — planner/agent | Ticket: AN-AGT-003

Planner LangGraph node implementation.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime
from typing import Any, Dict, List

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_ollama import ChatOllama

from shared.schemas import PipelineState, ActionPlan, CandidateAction, ActionParam
from planner.action_catalogue import map_lever_to_actions
from planner.whatif_engine import run_whatif
from planner.delta_forecast import score_forecast

log = logging.getLogger(__name__)

_llm = ChatOllama(model=os.getenv("OLLAMA_MODEL", "llama3.2"), temperature=0, base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"))

SYSTEM_PROMPT = """You are the Planner Agent. Produce an operator-facing explanation for candidate remediation actions."""


async def _explain_action(candidate: Dict[str, Any], rca_report: Dict[str, Any]) -> str:
	prompt = f"Explain candidate action and expected outcome: {candidate} based on RCA: {rca_report['summary']}"
	try:
		resp = await _llm.ainvoke([SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=prompt)])
		return resp.content.strip()
	except Exception:
		return "No explanation available."


async def planner_node(state: Dict[str, Any]) -> Dict[str, Any]:
	pipeline = PipelineState(**state)
	if pipeline.rca_report is None:
		log.error("planner_node called without rca_report")
		pipeline.pipeline_halted = True
		pipeline.halt_reason = "No RCA report"
		return pipeline.model_dump()

	rca = pipeline.rca_report
	lever = rca.hypothesis_tree.dominant_root.recommended_lever
	log.info("Planner: selected lever %s", lever)

	candidates_raw = map_lever_to_actions(lever, rca.model_dump(mode="json"))
	candidate_actions: List[CandidateAction] = []

	# generate CandidateAction objects and call whatif for top 2
	for idx, c in enumerate(candidates_raw):
		params = [ActionParam(name=k, value=v) for k, v in c.items() if k not in ("action_type", "profile")]
		ca = CandidateAction(
			action_type=c.get("action_type"),
			target_entity=c.get("slice_id") or c.get("cell_id") or "",
			parameters=params,
			expected_kpi_improvement={},
			risk_score=0.5,
			blast_radius_cells=1,
			reversible=(c.get("action_type") != "rollback"),
			rollback_plan="manual"
		)
		candidate_actions.append(ca)

	# Run what-if for top 2 candidates
	delta_forecast = {}
	for ca in candidate_actions[:2]:
		plan = {"action_type": ca.action_type, **{p.name: p.value for p in ca.parameters}}
		wf = await run_whatif(plan, horizon_ticks=120)
		df = score_forecast(wf)
		delta_forecast_key = f"cand_{len(delta_forecast)+1}"
		delta_forecast[delta_forecast_key] = {"whatif": wf, "score": df}
		ca.expected_kpi_improvement = wf.get("deltas", {})
		ca.risk_score = 1.0 - (df.get("confidence", 100)/100.0)

	if not candidate_actions:
		log.error("Planner: no candidate actions available for lever %s", lever)
		pipeline.pipeline_halted = True
		pipeline.halt_reason = f"No candidate actions for lever {lever}"
		return pipeline.model_dump()

	# Select best risk-adjusted plan (lowest risk_score / highest improvement)
	selected = max(candidate_actions, key=lambda x: sum(x.expected_kpi_improvement.values()) if x.expected_kpi_improvement else 0.0)

	approval_required = False
	# simple blast radius / peak hours / confidence checks
	nowh = datetime.utcnow().hour
	if selected and (selected.blast_radius_cells > 10 or (8 <= nowh <= 22) or any(v.get("score", {}).get("confidence", 100) < 60 for v in delta_forecast.values())):
		approval_required = True

	explanation = await _explain_action(selected.model_dump(), rca.model_dump(mode="json"))

	action_plan = ActionPlan(
		incident_id=rca.incident_id,
		selected_action=selected,
		candidate_alternatives=candidate_actions,
		delta_forecast=delta_forecast,
		approval_required=approval_required,
	)

	pipeline.action_plan = action_plan
	return pipeline.model_dump()
