"""
orchestrator/human_approval.py
-------------------------------
Human-in-the-loop approval node.

Triggered when the Safety Agent returns ALLOW_WITH_APPROVAL (blast radius > 10,
rate-limit exhausted but urgent, low what-if confidence, or peak-hour sensitive op).

Flow:
  1. Serialize approval request → Redis (TTL 30 min).
  2. Log operator-facing warning with the /approvals endpoint URL.
  3. Call interrupt() — LangGraph checkpoints state and suspends the thread.
  4. Resume path: operator POSTs to /approvals/{incident_id}/decision.
     - "approved" → continue to executor.
     - "rejected" → set pipeline_halted = True → graph routes to END.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict

from langgraph.types import interrupt

from shared.redis_client import set_value
from shared.schemas import PipelineState, PolicyDecision

log = logging.getLogger(__name__)

APPROVAL_TTL_SECONDS = 1800  # 30 minutes


async def human_approval_node(state: Dict[str, Any]) -> Dict[str, Any]:
    pipeline_state = PipelineState(**state)
    decision_record = pipeline_state.policy_decision

    incident_id = decision_record.incident_id if decision_record else "unknown"

    # Use event_id as LangGraph thread_id (set at invoke time in langgraph_runner.py)
    raw_event = state.get("raw_event") or {}
    thread_id = (
        raw_event.get("event_id")
        if isinstance(raw_event, dict)
        else getattr(raw_event, "event_id", incident_id)
    )

    approval_payload: Dict[str, Any] = {
        "thread_id": thread_id,
        "incident_id": incident_id,
        "reasons": decision_record.reasons if decision_record else [],
        "blast_radius": decision_record.blast_radius if decision_record else 0,
        "evaluated_rules": decision_record.evaluated_rules if decision_record else [],
        "requested_at": datetime.now(timezone.utc).isoformat(),
    }
    await set_value(
        f"approval:{incident_id}",
        json.dumps(approval_payload),
        APPROVAL_TTL_SECONDS,
    )

    log.warning(
        "HUMAN APPROVAL REQUIRED — incident=%s reasons=%s blast_radius=%d | "
        "POST /approvals/%s/decision  (TTL=%ds before auto-expire)",
        incident_id,
        approval_payload["reasons"],
        approval_payload["blast_radius"],
        incident_id,
        APPROVAL_TTL_SECONDS,
    )

    # Suspend here — execution resumes when the operator calls the approval endpoint
    response = interrupt(
        {"approval_required": True, "incident_id": incident_id, **approval_payload}
    )

    # ── Resume path ───────────────────────────────────────────────────────────
    decision = (
        response.get("decision", "rejected") if isinstance(response, dict) else "rejected"
    )
    approver = (
        response.get("approver", "unknown") if isinstance(response, dict) else "unknown"
    )

    if decision == "approved":
        log.info("Approval granted — incident=%s approver=%s", incident_id, approver)
        if pipeline_state.policy_decision:
            pipeline_state.policy_decision.decision = PolicyDecision.ALLOW
            pipeline_state.policy_decision.approver_role = approver
        if pipeline_state.action_plan:
            pipeline_state.action_plan.approval_required = False
        pipeline_state.human_approved_by = approver
        return pipeline_state.model_dump()

    log.warning("Approval rejected — incident=%s approver=%s", incident_id, approver)
    pipeline_state.pipeline_halted = True
    pipeline_state.halt_reason = f"Human approval rejected by {approver}"
    return pipeline_state.model_dump()
