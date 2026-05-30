"""AURA-NET — planner/delta_forecast | Ticket: AN-AGT-003

Parse and score what-if simulation output.
"""

from typing import Dict, Any


def score_forecast(forecast: Dict[str, Any]) -> Dict[str, Any]:
	# forecast expected structure: {"deltas": {kpi: {"improvement_pct": float}}, "confidence": 0-100}
	deltas = forecast.get("deltas", {})
	avg_improvement = 0.0
	count = 0
	for k, v in deltas.items():
		p = v.get("improvement_pct", 0.0)
		avg_improvement += p
		count += 1
	avg_improvement = avg_improvement / count if count else 0.0
	confidence = forecast.get("confidence", 100)
	return {"avg_improvement_pct": avg_improvement, "confidence": confidence}
