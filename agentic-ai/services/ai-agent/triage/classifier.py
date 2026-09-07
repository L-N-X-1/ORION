"""
triage/classifier.py
--------------------
Rule-based incident classifier.

Maps a raw NetworkEvent (or a KPI snapshot pattern) to one of the five
canonical IncidentType values and an initial Severity.

The rules are intentionally deterministic so the agent is testable
without an LLM call.  The LLM layer (agent.py) uses the classifier output
as a starting point and can refine it based on richer context.
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional, Tuple

from shared.schemas import IncidentType, KPISnapshot, NetworkEvent, Severity

# ── Threshold constants (match kpi_synthesizer.py in digital-twin) ──────────

PRB_CONGESTION_THRESHOLD = 95.0        # %
PRB_MODERATE_THRESHOLD = 80.0          # %
LATENCY_HIGH_MS = 50.0                 # ms  (example SLA)
HO_FAIL_HIGH = 0.10                    # fraction
PACKET_LOSS_HIGH = 2.0                 # %
SINR_LOW_DB = 0.0                      # dB  → interference / energy issue
THROUGHPUT_SLA_MBPS = 50.0            # Mbps  (premium slice SLA example)

# ── Event-type string → IncidentType mapping ─────────────────────────────────

_EVENT_TYPE_MAP: Dict[str, IncidentType] = {
    "CONGESTION": IncidentType.CONGESTION,
    "OUTAGE": IncidentType.OUTAGE,
    "BACKHAUL_DEGRADATION": IncidentType.BACKHAUL_DEGRADATION,
    "HO_FAILURE": IncidentType.MOBILITY_STORM,
    "MISCONFIGURATION": IncidentType.MISCONFIGURATION,
    "SIGNAL_DEGRADATION": IncidentType.CONGESTION,   # refined by RCA later
}


def classify_from_event(event: NetworkEvent) -> IncidentType:
    """
    Fast O(1) classification from the event_type string.
    Returns UNKNOWN if the event type is not recognised.
    """
    normalized = event.event_type.strip().upper()
    return _EVENT_TYPE_MAP.get(normalized, IncidentType.UNKNOWN)


def classify_from_kpis(kpis: List[KPISnapshot]) -> IncidentType:
    """
    Pattern-match KPI values to an incident type.
    Used when the event type is UNKNOWN or when we want a second opinion.

    Priority order (most specific → most generic):
    1. Outage          – any cell is SHUTDOWN
    2. Backhaul        – latency high but PRB low  (transport bottleneck)
    3. Mobility storm  – ho_fail_rate high
    4. Congestion      – PRB high
    5. Unknown
    """
    if not kpis:
        return IncidentType.UNKNOWN

    # Use the latest snapshot per entity
    latest = {snap.entity_id: snap for snap in kpis}.values()

    for snap in latest:
        if snap.energy_mode == "SHUTDOWN":
            return IncidentType.OUTAGE

    high_latency = any(
        s.latency_p95_ms > LATENCY_HIGH_MS and s.prb_utilization < PRB_MODERATE_THRESHOLD
        for s in latest
    )
    if high_latency:
        return IncidentType.BACKHAUL_DEGRADATION

    high_ho_fail = any(s.ho_fail_rate > HO_FAIL_HIGH for s in latest)
    if high_ho_fail:
        return IncidentType.MOBILITY_STORM

    high_prb = any(s.prb_utilization > PRB_CONGESTION_THRESHOLD for s in latest)
    if high_prb:
        return IncidentType.CONGESTION

    return IncidentType.UNKNOWN


def compute_severity(
    incident_type: IncidentType,
    kpis: List[KPISnapshot],
    severity_hint: str = "unknown",
) -> Severity:
    """
    Assign severity from three signals:
    1. Incident type weight (outage > congestion > …)
    2. KPI magnitude (how far over threshold)
    3. severity_hint from the digital-twin event (if trusted)

    Returns the highest severity computed from any signal.
    """
    scores: List[int] = []   # 0=low 1=medium 2=high 3=critical

    # ── Hint signal ──────────────────────────────────────────────────────────
    hint_map = {"low": 0, "medium": 1, "high": 2, "critical": 3}
    hint_score = hint_map.get(severity_hint.lower(), -1)
    if hint_score >= 0:
        scores.append(hint_score)

    # ── Incident-type baseline ────────────────────────────────────────────────
    type_baseline = {
        IncidentType.OUTAGE: 3,
        IncidentType.CONGESTION: 2,
        IncidentType.BACKHAUL_DEGRADATION: 2,
        IncidentType.MOBILITY_STORM: 1,
        IncidentType.MISCONFIGURATION: 1,
        IncidentType.UNKNOWN: 0,
    }
    scores.append(type_baseline.get(incident_type, 0))

    # ── KPI magnitude ────────────────────────────────────────────────────────
    if kpis:
        latest = {snap.entity_id: snap for snap in kpis}.values()
        sla_violations = sum(1 for s in latest if s.sla_violation)
        if sla_violations >= 3:
            scores.append(3)
        elif sla_violations >= 1:
            scores.append(2)

        max_prb = max((s.prb_utilization for s in latest), default=0)
        if max_prb >= 99:
            scores.append(3)
        elif max_prb >= 95:
            scores.append(2)

    final = max(scores, default=0)
    return [Severity.LOW, Severity.MEDIUM, Severity.HIGH, Severity.CRITICAL][final]