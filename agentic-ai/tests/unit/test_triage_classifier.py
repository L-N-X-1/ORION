"""
tests/unit/test_triage_classifier.py
-------------------------------------
Unit tests for triage/classifier.py.
No LLM calls, no HTTP calls, no Kafka — pure logic.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from triage.classifier import (
    classify_from_event,
    classify_from_kpis,
    compute_severity,
)
from shared.schemas import IncidentType, KPISnapshot, NetworkEvent, Severity


def _make_event(event_type: str, severity_hint: str = "unknown") -> NetworkEvent:
    return NetworkEvent(
        event_id="evt-001",
        correlation_id="corr-001",
        event_type=event_type,
        entity_id="cell-01",
        severity_hint=severity_hint,
        sim_time_s=100.0,
        timestamp=datetime.utcnow(),
    )


def _make_kpi(
    entity_id: str = "cell-01",
    prb: float = 50.0,
    latency: float = 20.0,
    ho_fail: float = 0.01,
    energy_mode: str = "ACTIVE",
    sla_violation: bool = False,
) -> KPISnapshot:
    return KPISnapshot(
        entity_id=entity_id,
        timestamp=datetime.utcnow(),
        prb_utilization=prb,
        throughput_mbps=80.0,
        sinr_db=15.0,
        cqi=10,
        latency_p95_ms=latency,
        packet_loss_pct=0.1,
        cpu_load_pct=30.0,
        ho_fail_rate=ho_fail,
        energy_mode=energy_mode,
        sla_violation=sla_violation,
    )


class TestClassifyFromEvent:
    def test_congestion(self):
        assert classify_from_event(_make_event("CONGESTION")) == IncidentType.CONGESTION

    def test_outage(self):
        assert classify_from_event(_make_event("OUTAGE")) == IncidentType.OUTAGE

    def test_backhaul_degradation(self):
        assert (
            classify_from_event(_make_event("BACKHAUL_DEGRADATION"))
            == IncidentType.BACKHAUL_DEGRADATION
        )

    def test_ho_failure_maps_to_mobility_storm(self):
        assert (
            classify_from_event(_make_event("HO_FAILURE"))
            == IncidentType.MOBILITY_STORM
        )

    def test_unknown_event_type(self):
        assert classify_from_event(_make_event("WEIRD_EVENT")) == IncidentType.UNKNOWN

    def test_case_insensitive(self):
        # event_type normalised to upper in classifier
        assert classify_from_event(_make_event("congestion")) == IncidentType.CONGESTION


class TestClassifyFromKPIs:
    def test_shutdown_returns_outage(self):
        kpis = [_make_kpi(energy_mode="SHUTDOWN")]
        assert classify_from_kpis(kpis) == IncidentType.OUTAGE

    def test_high_prb_returns_congestion(self):
        kpis = [_make_kpi(prb=97.0)]
        assert classify_from_kpis(kpis) == IncidentType.CONGESTION

    def test_high_latency_low_prb_returns_backhaul(self):
        kpis = [_make_kpi(prb=40.0, latency=80.0)]
        assert classify_from_kpis(kpis) == IncidentType.BACKHAUL_DEGRADATION

    def test_high_ho_fail_returns_mobility_storm(self):
        kpis = [_make_kpi(ho_fail=0.15)]
        assert classify_from_kpis(kpis) == IncidentType.MOBILITY_STORM

    def test_normal_kpis_return_unknown(self):
        kpis = [_make_kpi()]
        assert classify_from_kpis(kpis) == IncidentType.UNKNOWN

    def test_empty_returns_unknown(self):
        assert classify_from_kpis([]) == IncidentType.UNKNOWN


class TestComputeSeverity:
    def test_outage_is_critical(self):
        sev = compute_severity(IncidentType.OUTAGE, [], "unknown")
        assert sev == Severity.CRITICAL

    def test_hint_critical_overrides(self):
        sev = compute_severity(IncidentType.UNKNOWN, [], "critical")
        assert sev == Severity.CRITICAL

    def test_many_sla_violations_raise_severity(self):
        kpis = [_make_kpi(entity_id=f"cell-{i:02d}", sla_violation=True) for i in range(4)]
        sev = compute_severity(IncidentType.CONGESTION, kpis, "medium")
        assert sev == Severity.CRITICAL

    def test_congestion_without_sla_is_high(self):
        kpis = [_make_kpi(prb=96.0)]
        sev = compute_severity(IncidentType.CONGESTION, kpis, "unknown")
        assert sev == Severity.HIGH