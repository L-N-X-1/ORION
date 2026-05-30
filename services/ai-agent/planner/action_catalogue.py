"""AURA-NET — planner/action_catalogue | Ticket: AN-AGT-003

Provides mapping from remediation lever to concrete action parameters.
"""

from typing import Dict, Any, List


def map_lever_to_actions(lever: str, rca_report: Dict[str, Any]) -> List[Dict[str, Any]]:
	"""Return a list of candidate action parameter dicts for a lever."""
	candidates = []
	if lever == "apply_slice_policy":
		# find slice with SLA violation
		slice_id = "slice-premium"
		candidates.append({
			"action_type": "apply_slice_policy",
			"slice_id": slice_id,
			"min_bw_pct": None,
			"max_bw_pct": 80.0,
			"priority": None,
			"profile": "conservative",
		})
		candidates.append({
			"action_type": "apply_slice_policy",
			"slice_id": slice_id,
			"min_bw_pct": None,
			"max_bw_pct": 100.0,
			"priority": 1,
			"profile": "aggressive",
		})
	elif lever == "tune_handover":
		cell = rca_report.get("affected_nodes", [])[0]
		candidates.append({
			"action_type": "tune_handover",
			"cell_id": cell,
			"a3_offset": 2.0,
			"ttt_ms": 80.0,
			"profile": "conservative",
		})
		candidates.append({
			"action_type": "tune_handover",
			"cell_id": cell,
			"a3_offset": 4.0,
			"ttt_ms": 120.0,
			"profile": "aggressive",
		})
	elif lever == "enable_energy_saving":
		cell = rca_report.get("affected_nodes", [])[0]
		candidates.append({
			"action_type": "enable_energy_saving",
			"cell_id": cell,
			"mode": "ACTIVE",
			"profile": "minimal",
		})
	elif lever == "rollback":
		candidates.append({"action_type": "rollback", "profile": "rollback"})

	return candidates
