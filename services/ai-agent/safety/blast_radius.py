"""Compute blast radius (number of cells affected) from an ActionPlan."""

from typing import Dict, Any

def compute_blast_radius(action_plan: Dict[str, Any]) -> int:
	# simple heuristic based on action type
	sel = action_plan.get("selected_action", {})
	at = sel.get("action_type")
	if at == "apply_slice_policy":
		return 12
	if at == "tune_handover":
		return 3
	if at == "enable_energy_saving":
		return 6
	return 1
