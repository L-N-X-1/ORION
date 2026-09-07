"""
tests/unit/test_root_cause.py
------------------------------
Unit tests for root_cause/correlator.py and root_cause/hypothesis_tree.py.
No LLM, no HTTP, no Kafka.
"""

from __future__ import annotations

from datetime import datetime
from typing import Dict, List

import pytest

from root_cause.correlator import detect_pattern
from root_cause.hypothesis_tree import build_hypothesis_tree
from shared.schemas import IncidentType, KPISnapshot


def _snap(
    entity_id: str,
    prb: float = 50.0,
    latency: float = 20.0,
    ho_fail: float = 0.01,
    energy_mode: str = "ACTIVE",
    sla_violation: bool = False,
    sinr_db: float = 15.0,
    packet_loss: float = 0.1,
) -> KPISnapshot:
    return KPISnapshot(
        entity_id=entity_id,
        timestamp=datetime.utcnow(),
        prb_utilization=prb,
        throughput_mbps=80.0,
        sinr_db=sinr_db,
        cqi=10,
        latency_p95_ms=latency,
        packet_loss_pct=packet_loss,
        cpu_load_pct=30.0,
        ho_fail_rate=ho_fail,
        energy_mode=energy_mode,
        sla_violation=sla_violation,
    )


class TestDetectPattern:
    def test_congestion_pattern(self):
        kpis: Dict[str, List[KPISnapshot]] = {
            "c1": [_snap("c1", prb=96.0, sla_violation=True)],
            "c2": [_snap("c2", prb=93.0)],
        }
        result = detect_pattern(kpis)
        assert "c1" in result["congestion_cells"]
        assert result["dominant_pattern"] == IncidentType.CONGESTION

    def test_backhaul_pattern(self):
        kpis: Dict[str, List[KPISnapshot]] = {
            "c1": [_snap("c1", prb=40.0, latency=80.0)],
            "c2": [_snap("c2", prb=38.0, latency=75.0)],
        }
        result = detect_pattern(kpis)
        assert "c1" in result["backhaul_cells"]
        assert result["dominant_pattern"] == IncidentType.BACKHAUL_DEGRADATION

    def test_mobility_storm_pattern(self):
        kpis: Dict[str, List[KPISnapshot]] = {
            "c1": [_snap("c1", ho_fail=0.15)],
            "c2": [_snap("c2", ho_fail=0.12)],
        }
        result = detect_pattern(kpis)
        assert "c1" in result["mobility_storm_cells"]
        assert result["dominant_pattern"] == IncidentType.MOBILITY_STORM

    def test_empty_kpis(self):
        result = detect_pattern({})
        assert result["dominant_pattern"] == IncidentType.UNKNOWN


class TestBuildHypothesisTree:
    def test_congestion_produces_h1(self):
        pattern = {
            "congestion_cells": ["c1", "c2"],
            "backhaul_cells": [],
            "mobility_storm_cells": [],
            "sinr_degraded_cells": [],
            "sla_violation_cells": ["c1"],
            "dominant_pattern": IncidentType.CONGESTION,
        }
        kpis = {
            "c1": [_snap("c1", prb=96.0, sla_violation=True)],
            "c2": [_snap("c2", prb=91.0)],
        }
        tree = build_hypothesis_tree(pattern, kpis, {})
        assert tree.dominant_root.label == "traffic_burst_slice_too_narrow"
        assert tree.dominant_root.confidence > 0.5
        assert tree.dominant_root.recommended_lever == "apply_slice_policy"

    def test_backhaul_produces_h2(self):
        pattern = {
            "congestion_cells": [],
            "backhaul_cells": ["c1"],
            "mobility_storm_cells": [],
            "sinr_degraded_cells": [],
            "sla_violation_cells": [],
            "dominant_pattern": IncidentType.BACKHAUL_DEGRADATION,
        }
        kpis = {"c1": [_snap("c1", latency=80.0, prb=35.0)]}
        tree = build_hypothesis_tree(pattern, kpis, {})
        assert any(h.label == "backhaul_capacity_reduction" for h in tree.hypotheses)

    def test_energy_saving_failure_detected(self):
        pattern = {
            "congestion_cells": ["c1"],
            "backhaul_cells": [],
            "mobility_storm_cells": [],
            "sinr_degraded_cells": [],
            "sla_violation_cells": [],
            "dominant_pattern": IncidentType.CONGESTION,
        }
        kpis = {"c1": [_snap("c1", prb=96.0, energy_mode="SLEEP")]}
        tree = build_hypothesis_tree(pattern, kpis, {})
        labels = [h.label for h in tree.hypotheses]
        assert "cell_energy_saving_failure" in labels
        # Energy saving failure has hardcoded 0.85 confidence → should be dominant
        assert tree.dominant_root.label == "cell_energy_saving_failure"

    def test_empty_pattern_returns_unknown_hypothesis(self):
        pattern = {
            "congestion_cells": [],
            "backhaul_cells": [],
            "mobility_storm_cells": [],
            "sinr_degraded_cells": [],
            "sla_violation_cells": [],
            "dominant_pattern": IncidentType.UNKNOWN,
        }
        tree = build_hypothesis_tree(pattern, {}, {})
        assert tree.dominant_root.label == "unknown_root_cause"
        assert tree.dominant_root.confidence < 0.5

    def test_hypotheses_sorted_by_confidence(self):
        pattern = {
            "congestion_cells": ["c1"],
            "backhaul_cells": ["c1"],
            "mobility_storm_cells": [],
            "sinr_degraded_cells": [],
            "sla_violation_cells": [],
            "dominant_pattern": IncidentType.CONGESTION,
        }
        kpis = {"c1": [_snap("c1", prb=96.0, latency=70.0)]}
        tree = build_hypothesis_tree(pattern, kpis, {})
        confidences = [h.confidence for h in tree.hypotheses]
        assert confidences == sorted(confidences, reverse=True)