"""
root_cause/hypothesis_tree.py
------------------------------
Builds a ranked HypothesisTree from the pattern analysis produced by
the correlator and the topology graph.

Each hypothesis has a confidence score computed from:
  - pattern match strength (how many cells show the signature)
  - KPI magnitude (how far above/below threshold)
  - topology match (e.g., backhaul issue shared across peer cells)
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List

from shared.schemas import Hypothesis, HypothesisTree, IncidentType, KPISnapshot

log = logging.getLogger(__name__)

# Remediation lever lookup per hypothesis type
_LEVER_MAP = {
    "traffic_burst_slice_too_narrow": "apply_slice_policy",
    "slice_policy_misconfiguration":  "apply_slice_policy",
    "backhaul_capacity_reduction":    "tune_handover",   # reroute / escalate
    "bad_handover_parameters":        "tune_handover",
    "cell_energy_saving_failure":     "enable_energy_saving",
    "cell_outage":                    "rollback",
}


def build_hypothesis_tree(
    pattern: Dict[str, Any],
    kpis_by_entity: Dict[str, List[KPISnapshot]],
    topology: Dict[str, Any],
) -> HypothesisTree:
    """
    Produce a ranked HypothesisTree with confidence scores.

    pattern         — output of correlator.detect_pattern()
    kpis_by_entity  — {entity_id: [KPISnapshot, ...]}
    topology        — topology graph (neighbours, backhaul_peers, …)
    """
    hypotheses: List[Hypothesis] = []
    dominant: IncidentType = pattern.get("dominant_pattern", IncidentType.UNKNOWN)

    # ── H1: Traffic burst with too-narrow slice allocation ────────────────────
    if pattern["congestion_cells"]:
        n = len(pattern["congestion_cells"])
        # Confidence scales with: number of congested cells + SLA violations
        sla_hits = len(pattern["sla_violation_cells"])
        confidence = min(0.4 + 0.1 * n + 0.1 * sla_hits, 0.95)
        hypotheses.append(
            Hypothesis(
                rank=1,
                label="traffic_burst_slice_too_narrow",
                description=(
                    f"{n} cell(s) at PRB > 90%. Traffic burst exceeds current "
                    "slice min/max allocation. Premium slice throughput at risk."
                ),
                confidence=round(confidence, 2),
                supporting_kpis=["prb_utilization", "throughput_mbps", "sla_violation"],
                recommended_lever=_LEVER_MAP["traffic_burst_slice_too_narrow"],
            )
        )

    # ── H2: Backhaul capacity reduction ──────────────────────────────────────
    if pattern["backhaul_cells"]:
        n = len(pattern["backhaul_cells"])
        # Confidence is higher when multiple peers are affected (shared link)
        backhaul_peers = len(topology.get("backhaul_peers", []))
        confidence = min(0.35 + 0.12 * n + 0.08 * backhaul_peers, 0.90)
        hypotheses.append(
            Hypothesis(
                rank=2,
                label="backhaul_capacity_reduction",
                description=(
                    f"{n} cell(s) show high latency with normal PRB — "
                    "consistent with transport link degradation."
                ),
                confidence=round(confidence, 2),
                supporting_kpis=["latency_p95_ms", "packet_loss_pct"],
                recommended_lever=_LEVER_MAP["backhaul_capacity_reduction"],
            )
        )

    # ── H3: Slice policy misconfiguration ────────────────────────────────────
    if pattern["sla_violation_cells"] and not pattern["congestion_cells"]:
        confidence = min(0.30 + 0.1 * len(pattern["sla_violation_cells"]), 0.75)
        hypotheses.append(
            Hypothesis(
                rank=3,
                label="slice_policy_misconfiguration",
                description=(
                    "SLA violations present without high PRB — "
                    "slice min/max bounds may be misconfigured, "
                    "starving the premium slice."
                ),
                confidence=round(confidence, 2),
                supporting_kpis=["sla_violation", "throughput_mbps"],
                recommended_lever=_LEVER_MAP["slice_policy_misconfiguration"],
            )
        )

    # ── H4: Bad handover parameters → mobility storm ─────────────────────────
    if pattern["mobility_storm_cells"]:
        n = len(pattern["mobility_storm_cells"])
        confidence = min(0.25 + 0.12 * n, 0.80)
        hypotheses.append(
            Hypothesis(
                rank=4,
                label="bad_handover_parameters",
                description=(
                    f"{n} cell(s) with elevated HO failure rate. "
                    "A3 offset may be set too low or TTT too short."
                ),
                confidence=round(confidence, 2),
                supporting_kpis=["ho_fail_rate", "throughput_mbps"],
                recommended_lever=_LEVER_MAP["bad_handover_parameters"],
            )
        )

    # ── H5: Energy saving mis-applied during peak load ────────────────────────
    for eid, snaps in kpis_by_entity.items():
        if snaps and snaps[-1].energy_mode in ("SLEEP", "SHUTDOWN"):
            hypotheses.append(
                Hypothesis(
                    rank=5,
                    label="cell_energy_saving_failure",
                    description=(
                        f"Cell {eid} is in {snaps[-1].energy_mode} mode "
                        "during peak load — capacity dropped, neighbours overloaded."
                    ),
                    confidence=0.85,
                    supporting_kpis=["energy_mode", "prb_utilization"],
                    recommended_lever=_LEVER_MAP["cell_energy_saving_failure"],
                )
            )
            break  # one entry is enough; multiple cells handled by n in H1

    # ── Sort by confidence and re-number ranks ────────────────────────────────
    hypotheses.sort(key=lambda h: h.confidence, reverse=True)
    for i, h in enumerate(hypotheses, start=1):
        h.rank = i

    if not hypotheses:
        hypotheses.append(
            Hypothesis(
                rank=1,
                label="unknown_root_cause",
                description="Insufficient KPI data to determine root cause.",
                confidence=0.10,
                supporting_kpis=[],
                recommended_lever="",
            )
        )

    dominant_hyp = hypotheses[0]

    # Verification checks passed to the Planner
    verification_checks = _build_verification_checks(hypotheses, pattern)

    return HypothesisTree(
        hypotheses=hypotheses,
        dominant_root=dominant_hyp,
        verification_checks=verification_checks,
    )


def _build_verification_checks(
    hypotheses: List[Hypothesis],
    pattern: Dict[str, Any],
) -> List[str]:
    checks: List[str] = []
    labels = {h.label for h in hypotheses}

    if "traffic_burst_slice_too_narrow" in labels:
        checks.append(
            "Verify neighbour PRB correlation > 0.7 across congested cluster."
        )
        checks.append(
            "Check premium-slice throughput vs SLA threshold for last 5 ticks."
        )
    if "backhaul_capacity_reduction" in labels:
        checks.append(
            "Compare backhaul link delay_ms before and after event timestamp."
        )
        checks.append(
            "Confirm latency elevation is correlated across cells sharing same backhaul."
        )
    if "bad_handover_parameters" in labels:
        checks.append(
            "Check HO failure spike timing against A3/TTT parameter change history."
        )
    if "cell_energy_saving_failure" in labels:
        checks.append(
            "Confirm SLEEP/SHUTDOWN cell neighbour PRB jumped > 15% after mode change."
        )
    return checks