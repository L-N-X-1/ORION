"""
triage/incident_record.py
-------------------------
Factory helpers for creating and enriching IncidentRecord objects.

Keeps the Triage Agent's agent.py clean by centralising all the
IncidentRecord construction logic here.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import List, Optional

from shared.schemas import (
    IncidentRecord,
    IncidentType,
    KPISnapshot,
    NetworkEvent,
    Severity,
)


def new_incident(
    event: NetworkEvent,
    incident_type: IncidentType,
    severity: Severity,
    affected_entities: List[str],
    evidence_kpis: List[KPISnapshot],
    pre_incident_baseline: List[KPISnapshot],
    candidate_correlated_entities: Optional[List[str]] = None,
    summary: str = "",
) -> IncidentRecord:
    """Create a fresh IncidentRecord from a NetworkEvent."""
    return IncidentRecord(
        incident_id=f"INC-{uuid.uuid4().hex[:8].upper()}",
        correlation_id=event.correlation_id,
        incident_type=incident_type,
        severity=severity,
        affected_entities=affected_entities,
        candidate_correlated_entities=candidate_correlated_entities or [],
        evidence_kpis=evidence_kpis,
        pre_incident_baseline=pre_incident_baseline,
        timeline_start=event.timestamp,
        summary=summary,
    )


def enrich_incident(
    record: IncidentRecord,
    extra_entities: List[str],
    extra_kpis: List[KPISnapshot],
) -> IncidentRecord:
    """
    Add newly discovered entities and KPI snapshots to an existing record.
    Called when a duplicate event arrives for the same correlation_id.
    """
    merged_entities = list(
        set(record.affected_entities) | set(extra_entities)
    )
    merged_kpis = record.evidence_kpis + [
        kpi for kpi in extra_kpis if kpi not in record.evidence_kpis
    ]
    return record.model_copy(
        update={
            "affected_entities": merged_entities,
            "evidence_kpis": merged_kpis,
        }
    )