"""AURA-NET — planner/agent | Ticket: AN-AGT-003

Planner LangGraph node implementation.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime
from typing import Any, Dict, List, Tuple

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_ollama import ChatOllama

from shared.schemas import PipelineState, ActionPlan, CandidateAction, ActionParam
from planner.action_catalogue import map_lever_to_actions
from planner.whatif_engine import run_whatif
from planner.delta_forecast import score_forecast

log = logging.getLogger(__name__)

_llm = ChatOllama(
    model=os.getenv("OLLAMA_MODEL", "llama3.2"),
    temperature=0,
    base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
)

SYSTEM_PROMPT = """\
You are the AURA-NET Planner Agent.  Select the single best remediation action.

Given a list of candidate actions with their what-if simulation scores, the RCA
summary, and network context, output only valid JSON:

{
  "chosen_index": <0-based integer>,
  "rationale": "<one sentence why this candidate is optimal>"
}

Rules:
- Prefer lower risk_score during peak hours (08-22 UTC).
- Prefer higher KPI improvement when risk is comparable.
- Never output anything outside the JSON object.
"""


async def _llm_select_action(
    candidates: List[CandidateAction],
    delta_forecast: Dict[str, Any],
    rca: Any,
    hour: int,
) -> Tuple[int, str]:
    """
    Ask LLM to pick the best candidate action index.
    Returns (index, rationale).  Falls back to deterministic on any failure.
    """
    cand_summary = []
    for i, ca in enumerate(candidates):
        params = {p.name: p.value for p in ca.parameters}
        df = delta_forecast.get(f"cand_{i + 1}", {})
        cand_summary.append({
            "index": i,
            "action_type": ca.action_type,
            "params": params,
            "expected_improvement": ca.expected_kpi_improvement,
            "risk_score": round(ca.risk_score, 3),
            "whatif_confidence": df.get("score", {}).get("confidence", "n/a"),
        })

    rca_dump = rca.model_dump(mode="json") if hasattr(rca, "model_dump") else rca
    prompt = (
        f"UTC hour: {hour} ({'PEAK' if 8 <= hour <= 22 else 'OFF-PEAK'})\n"
        f"Incident type: {rca_dump.get('root_cause_classification', 'unknown')}\n"
        f"RCA summary (first 250 chars): {str(rca_dump.get('summary', ''))[:250]}\n\n"
        f"Candidate actions:\n{json.dumps(cand_summary, indent=2)}\n\n"
        "Select the best action and respond with JSON only:"
    )

    try:
        resp = await _llm.ainvoke(
            [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=prompt)]
        )
        log.info("LLM action selection raw response: %s", resp.content[:300])
        match = re.search(r"\{[^{}]*\}", resp.content, re.DOTALL)
        if match:
            parsed = json.loads(match.group())
            idx = int(parsed["chosen_index"])
            rationale = str(parsed.get("rationale", "LLM selection"))
            if 0 <= idx < len(candidates):
                log.info("LLM selected candidate %d: %s", idx, rationale)
                return idx, rationale
            log.warning("LLM returned out-of-range index %d — falling back", idx)
    except Exception as exc:
        log.warning("LLM action selection failed (%s) — deterministic fallback", exc)

    # Deterministic fallback: pick candidate with highest expected KPI improvement
    fallback_idx = max(
        range(len(candidates)),
        key=lambda i: sum(candidates[i].expected_kpi_improvement.values())
        if candidates[i].expected_kpi_improvement else 0.0,
    )
    return fallback_idx, "Deterministic fallback: highest expected KPI improvement"


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

    for c in candidates_raw:
        params = [ActionParam(name=k, value=v) for k, v in c.items() if k not in ("action_type", "profile")]
        ca = CandidateAction(
            action_type=c.get("action_type"),
            target_entity=c.get("slice_id") or c.get("cell_id") or "",
            parameters=params,
            expected_kpi_improvement={},
            risk_score=0.5,
            blast_radius_cells=1,
            reversible=(c.get("action_type") != "rollback"),
            rollback_plan="manual",
        )
        candidate_actions.append(ca)

    # Run what-if for top 2 candidates
    delta_forecast: Dict[str, Any] = {}
    for ca in candidate_actions[:2]:
        plan = {"action_type": ca.action_type, **{p.name: p.value for p in ca.parameters}}
        wf = await run_whatif(plan, horizon_ticks=120)
        df = score_forecast(wf)
        key = f"cand_{len(delta_forecast) + 1}"
        delta_forecast[key] = {"whatif": wf, "score": df}
        ca.expected_kpi_improvement = wf.get("deltas", {})
        ca.risk_score = 1.0 - (df.get("confidence", 100) / 100.0)

    if not candidate_actions:
        log.error("Planner: no candidate actions for lever %s", lever)
        pipeline.pipeline_halted = True
        pipeline.halt_reason = f"No candidate actions for lever {lever}"
        return pipeline.model_dump()

    # LLM picks best candidate; falls back to deterministic if LLM unavailable
    nowh = datetime.utcnow().hour
    chosen_idx, rationale = await _llm_select_action(candidate_actions, delta_forecast, rca, nowh)
    selected = candidate_actions[chosen_idx]

    approval_required = False
    if selected and (
        selected.blast_radius_cells > 10
        or (8 <= nowh <= 22)
        or any(v.get("score", {}).get("confidence", 100) < 60 for v in delta_forecast.values())
    ):
        approval_required = True

    action_plan = ActionPlan(
        incident_id=rca.incident_id,
        selected_action=selected,
        candidate_alternatives=candidate_actions,
        delta_forecast=delta_forecast,
        approval_required=approval_required,
        rationale=rationale,
    )

    pipeline.action_plan = action_plan
    return pipeline.model_dump()
