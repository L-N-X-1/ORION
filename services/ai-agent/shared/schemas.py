"""
shared/schemas.py
-----------------
Pydantic models that flow as structured artifacts between agents in the
LangGraph pipeline.  Every agent receives one of these models as input and
emits a richer one as output.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ─────────────────────────────────────────────
# Enumerations
# ─────────────────────────────────────────────

class Severity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class IncidentType(str, Enum):
    CONGESTION = "congestion"
    OUTAGE = "outage"
    MOBILITY_STORM = "mobility_storm"
    BACKHAUL_DEGRADATION = "backhaul_degradation"
    MISCONFIGURATION = "misconfiguration"
    UNKNOWN = "unknown"


class PolicyDecision(str, Enum):
    ALLOW = "allow"
    ALLOW_WITH_APPROVAL = "allow_with_approval"
    DENY = "deny"


# ─────────────────────────────────────────────
# KPI snapshot (one cell, one tick window)
# ─────────────────────────────────────────────

class KPISnapshot(BaseModel):
    entity_id: str
    timestamp: datetime
    prb_utilization: float = Field(..., ge=0, le=100, description="PRB utilisation %")
    throughput_mbps: float
    sinr_db: float
    cqi: int = Field(..., ge=0, le=15)
    latency_p95_ms: float
    packet_loss_pct: float
    cpu_load_pct: float
    ho_fail_rate: float = Field(..., ge=0, le=1, description="Handover failure rate 0-1")
    energy_mode: str = Field(default="ACTIVE", description="ACTIVE / SLEEP / SHUTDOWN")
    sla_violation: bool = False
    is_peak: bool = False


# ─────────────────────────────────────────────
# Raw event coming from the Digital Twin / Kafka
# ─────────────────────────────────────────────

class NetworkEvent(BaseModel):
    event_id: str
    correlation_id: str
    event_type: str                        # CONGESTION, OUTAGE, BACKHAUL_DEGRADATION …
    entity_id: str
    severity_hint: str = "unknown"
    sim_time_s: float
    timestamp: datetime
    extra: Dict[str, Any] = Field(default_factory=dict)


# ─────────────────────────────────────────────
# Triage output — IncidentRecord
# ─────────────────────────────────────────────

class IncidentRecord(BaseModel):
    incident_id: str
    correlation_id: str
    incident_type: IncidentType
    severity: Severity
    affected_entities: List[str]           # cell / backhaul / slice IDs
    candidate_correlated_entities: List[str] = Field(default_factory=list)
    evidence_kpis: List[KPISnapshot] = Field(default_factory=list)
    pre_incident_baseline: List[KPISnapshot] = Field(default_factory=list)
    timeline_start: datetime
    timeline_end: Optional[datetime] = None
    summary: str = ""
    ticket_id: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


# ─────────────────────────────────────────────
# Root-Cause output — HypothesisTree + RCA Report
# ─────────────────────────────────────────────

class Hypothesis(BaseModel):
    rank: int
    label: str
    description: str
    confidence: float = Field(..., ge=0.0, le=1.0)
    supporting_kpis: List[str] = Field(default_factory=list)
    recommended_lever: str = ""            # e.g. "apply_slice_policy"


class HypothesisTree(BaseModel):
    hypotheses: List[Hypothesis]
    dominant_root: Hypothesis              # highest-confidence hypothesis
    verification_checks: List[str] = Field(default_factory=list)


class RCAReport(BaseModel):
    incident_id: str
    root_cause_classification: IncidentType
    affected_nodes: List[str]
    correlated_kpis: Dict[str, Any]        # entity_id → {kpi: value}
    hypothesis_tree: HypothesisTree
    remediation_levers: List[str]
    summary: str
    generated_at: datetime = Field(default_factory=datetime.utcnow)


# ─────────────────────────────────────────────
# Planner output — ActionPlan + Delta Forecast
# ─────────────────────────────────────────────

class ActionParam(BaseModel):
    name: str
    value: Any


class CandidateAction(BaseModel):
    action_type: str                       # apply_slice_policy / tune_handover / …
    target_entity: str
    parameters: List[ActionParam]
    expected_kpi_improvement: Dict[str, float] = Field(default_factory=dict)
    risk_score: float = Field(default=0.5, ge=0, le=1)
    blast_radius_cells: int = 0
    reversible: bool = True
    rollback_plan: str = ""


class ActionPlan(BaseModel):
    incident_id: str
    selected_action: CandidateAction
    candidate_alternatives: List[CandidateAction] = Field(default_factory=list)
    delta_forecast: Dict[str, Any] = Field(default_factory=dict)
    approval_required: bool = False
    created_at: datetime = Field(default_factory=datetime.utcnow)


# ─────────────────────────────────────────────
# Safety output — PolicyDecisionRecord
# ─────────────────────────────────────────────

class PolicyDecisionRecord(BaseModel):
    incident_id: str
    decision: PolicyDecision
    reasons: List[str] = Field(default_factory=list)
    evaluated_rules: List[str] = Field(default_factory=list)
    blast_radius: int = 0
    rate_limit_remaining: int = 3
    approver_role: Optional[str] = None
    audit_timestamp: datetime = Field(default_factory=datetime.utcnow)


# ─────────────────────────────────────────────
# Executor output — ChangeConfirmation
# ─────────────────────────────────────────────

class ChangeConfirmation(BaseModel):
    change_id: str
    incident_id: str
    action_type: str
    parameters_applied: Dict[str, Any]
    pre_change_kpi_ref: str                # pointer to snapshot stored in memory
    approval_source: str
    sim_time_s: float
    executed_at: datetime = Field(default_factory=datetime.utcnow)


# ─────────────────────────────────────────────
# Verifier output — VerificationReport
# ─────────────────────────────────────────────

class VerificationReport(BaseModel):
    change_id: str
    incident_id: str
    outcome: str                           # success / partial / regression
    kpi_before: Dict[str, float]
    kpi_after: Dict[str, float]
    rollback_triggered: bool = False
    final_sla_state: bool = False          # True = SLA met
    postmortem_url: Optional[str] = None
    verified_at: datetime = Field(default_factory=datetime.utcnow)


# ─────────────────────────────────────────────
# LangGraph overall pipeline state
# ─────────────────────────────────────────────

class PipelineState(BaseModel):
    """
    The single mutable state object threaded through every node in the
    LangGraph pipeline.  Each agent reads what it needs and writes its output
    back into this state.
    """
    # Trigger
    raw_event: Optional[NetworkEvent] = None

    # Agent outputs — populated progressively
    incident_record: Optional[IncidentRecord] = None
    rca_report: Optional[RCAReport] = None
    action_plan: Optional[ActionPlan] = None
    policy_decision: Optional[PolicyDecisionRecord] = None
    change_confirmation: Optional[ChangeConfirmation] = None
    verification_report: Optional[VerificationReport] = None

    # Pipeline control
    error: Optional[str] = None
    pipeline_halted: bool = False
    halt_reason: Optional[str] = None