"""Policy engine implementing deterministic rules for safety decisions."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Dict, Any, List

from shared.schemas import PolicyDecision, PolicyDecisionRecord


def evaluate(action_plan: Dict[str, Any], incident: Dict[str, Any], recent_change_count: int, blast_radius: int, whatif_confidences: List[float]) -> PolicyDecisionRecord:
	reasons: List[str] = []
	evaluated: List[str] = []
	# POL-005: rollback always allow
	if action_plan.get("selected_action", {}).get("action_type") == "rollback":
		return PolicyDecisionRecord(incident_id=incident.get("incident_id"), decision=PolicyDecision.ALLOW, reasons=["rollback auto-approved"], evaluated_rules=["POL-005"], blast_radius=blast_radius)

	# POL-001: deny energy saving during peak if mode SLEEP/SHUTDOWN
	sel = action_plan.get("selected_action", {})
	a_type = sel.get("action_type")
	params = {p["name"]: p["value"] for p in sel.get("parameters", [])}
	hour = datetime.utcnow().hour
	if a_type == "enable_energy_saving" and params.get("mode") in ("SLEEP", "SHUTDOWN") and 8 <= hour <= 22:
		return PolicyDecisionRecord(incident_id=incident.get("incident_id"), decision=PolicyDecision.DENY, reasons=["Energy saving disallowed during peak hours"], evaluated_rules=["POL-001"], blast_radius=blast_radius)

	# POL-002: blast radius > 10 -> require approval
	if blast_radius > 10:
		reasons.append("Blast radius exceeds 10 cells")
		evaluated.append("POL-002")

	# POL-003: recent change rate limit
	if recent_change_count > 3:
		reasons.append("High recent change rate")
		evaluated.append("POL-003")

	# POL-004: low what-if confidence
	if any(c < 60 for c in whatif_confidences) and blast_radius > 3:
		reasons.append("Low what-if confidence for action")
		evaluated.append("POL-004")

	# POL-006: critical incident allow slice policy
	if incident.get("severity") == "critical" and a_type == "apply_slice_policy":
		return PolicyDecisionRecord(incident_id=incident.get("incident_id"), decision=PolicyDecision.ALLOW, reasons=["Critical incident: auto-allow slice policy"], evaluated_rules=["POL-006"], blast_radius=blast_radius)

	if reasons:
		return PolicyDecisionRecord(incident_id=incident.get("incident_id"), decision=PolicyDecision.ALLOW_WITH_APPROVAL, reasons=reasons, evaluated_rules=evaluated, blast_radius=blast_radius)

	return PolicyDecisionRecord(incident_id=incident.get("incident_id"), decision=PolicyDecision.ALLOW, reasons=["All checks passed"], evaluated_rules=[], blast_radius=blast_radius)
