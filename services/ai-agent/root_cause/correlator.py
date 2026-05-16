"""
root_cause/correlator.py
------------------------
Cross-cell KPI correlation engine for the Root Cause Agent.

Given a list of entity IDs and their KPI snapshots, this module computes
pairwise correlations and returns the canonical pattern signatures that the
hypothesis builder uses to distinguish congestion, backhaul issues, and
mobility storms.
"""

from __future__ import annotations

import logging
from typing import Dict, List, Tuple

from shared.schemas import IncidentType, KPISnapshot

log = logging.getLogger(__name__)

# ── Thresholds (mirrors triage/classifier.py) ─────────────────────────────────

PRB_HIGH = 90.0
LATENCY_HIGH_MS = 50.0
HO_FAIL_HIGH = 0.10
PACKET_LOSS_HIGH = 2.0
SINR_LOW_DB = 3.0       # below this suggests interference or energy saving
THROUGHPUT_DROP_RATIO = 0.6   # below 60% of nominal → SLA risk


def correlation_matrix(
    kpis_by_entity: Dict[str, List[KPISnapshot]],
) -> Dict[Tuple[str, str], float]:
    """
    Compute a simple Pearson-like correlation for the PRB utilisation series
    across entity pairs.

    Returns a dict {(entity_a, entity_b): correlation_coefficient}.
    Correlation is in [-1, 1]; values > 0.7 indicate spatially linked load.
    """
    # Build per-entity PRB series aligned by position
    series: Dict[str, List[float]] = {}
    for eid, snaps in kpis_by_entity.items():
        series[eid] = [s.prb_utilization for s in snaps]

    result: Dict[Tuple[str, str], float] = {}
    entities = list(series.keys())
    for i, a in enumerate(entities):
        for b in entities[i + 1:]:
            corr = _pearson(series[a], series[b])
            result[(a, b)] = corr
    return result


def _pearson(xs: List[float], ys: List[float]) -> float:
    """Pearson correlation coefficient between two equal-length lists."""
    n = min(len(xs), len(ys))
    if n < 2:
        return 0.0
    xs, ys = xs[:n], ys[:n]
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = (sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys)) ** 0.5
    return num / den if den else 0.0


def detect_pattern(
    kpis_by_entity: Dict[str, List[KPISnapshot]],
) -> Dict[str, object]:
    """
    Analyse KPI patterns across all entities and return a pattern summary dict:

    {
        "congestion_cells":        [entity_id, ...],
        "backhaul_cells":          [entity_id, ...],
        "mobility_storm_cells":    [entity_id, ...],
        "sinr_degraded_cells":     [entity_id, ...],
        "sla_violation_cells":     [entity_id, ...],
        "dominant_pattern":        IncidentType,
    }
    """
    congestion: List[str] = []
    backhaul: List[str] = []
    mobility: List[str] = []
    sinr_degraded: List[str] = []
    sla_violated: List[str] = []

    for eid, snaps in kpis_by_entity.items():
        if not snaps:
            continue
        latest = snaps[-1]

        if latest.sla_violation:
            sla_violated.append(eid)

        if latest.prb_utilization >= PRB_HIGH:
            congestion.append(eid)

        if (
            latest.latency_p95_ms >= LATENCY_HIGH_MS
            and latest.prb_utilization < PRB_HIGH
        ):
            backhaul.append(eid)

        if latest.ho_fail_rate >= HO_FAIL_HIGH:
            mobility.append(eid)

        if latest.sinr_db < SINR_LOW_DB:
            sinr_degraded.append(eid)

    # Dominant pattern: most cells showing that signature
    counts = {
        IncidentType.CONGESTION: len(congestion),
        IncidentType.BACKHAUL_DEGRADATION: len(backhaul),
        IncidentType.MOBILITY_STORM: len(mobility),
    }
    dominant = max(counts, key=lambda k: counts[k])
    if counts[dominant] == 0:
        dominant = IncidentType.UNKNOWN

    return {
        "congestion_cells": congestion,
        "backhaul_cells": backhaul,
        "mobility_storm_cells": mobility,
        "sinr_degraded_cells": sinr_degraded,
        "sla_violation_cells": sla_violated,
        "dominant_pattern": dominant,
    }