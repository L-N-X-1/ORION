"""
AURA-NET Digital Twin — kpi_synthesizer.py
Ticket: AN-TWN-001

Synthesizes all 10 KPIs per cell per tick from the WorldState.
Formulas are physically motivated but simplified — the goal is
directionally correct agent-observable dynamics, not radio physics.

KPIs produced per cell:
  prb_util, throughput_mbps, sinr_db, cqi,
  latency_p95_ms, packet_loss_pct, cpu_load_pct,
  ho_fail_rate, energy_mode, sla_violation
"""
from __future__ import annotations

import math
import random
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from world_state import WorldState, Cell

# CQI lookup: SINR (dB) → CQI index (0-15) — 3GPP-aligned
_SINR_TO_CQI = [
    (-6.0, 0), (-4.0, 1), (-2.0, 2), (0.0, 3),
    (2.0, 4),  (4.0, 5),  (6.0, 6),  (8.0, 7),
    (10.0, 8), (12.0, 9), (14.0, 10),(16.0, 11),
    (18.0, 12),(20.0, 13),(22.0, 14),(25.0, 15),
]


def _sinr_to_cqi(sinr_db: float) -> int:
    for threshold, cqi in _SINR_TO_CQI:
        if sinr_db <= threshold:
            return cqi
    return 15


class KpiSynthesizer:

    def __init__(self, seed: int = 42) -> None:
        self._rng = random.Random(seed)

    # ── Main entry point ────────────────────────────────────────────

    def synthesize(self, state: "WorldState", tick: int, is_peak: bool) -> list[dict]:
        """
        Compute one KPI snapshot per cell and push into WorldState history.
        Returns the list of KPI dicts (one per cell).
        """
        results = []
        for cell_id, cell in state.cells.items():
            kpi = self._compute_cell_kpi(cell, state, tick, is_peak)
            state.push_kpi(cell_id, kpi)
            results.append(kpi)
        return results

    # ── Per-cell computation ────────────────────────────────────────

    def _compute_cell_kpi(self, cell: "Cell", state: "WorldState",
                          tick: int, is_peak: bool) -> dict:
        from world_state import EnergyMode

        bh    = state.backhaul[cell.cell_id]
        prb   = cell.prb_utilization          # 0-100
        load  = cell.current_load             # 0-1

        # ── PRB utilization ─────────────────────────────
        # Already computed as property; add small tick-level noise
        prb_util = float(min(100.0, max(0.0,
            prb + self._rng.gauss(0, 0.5)
        )))

        # ── Throughput (Mbps) ────────────────────────────
        # Degrades non-linearly above 80% PRB
        raw_tp = (prb_util / 100) * cell.max_throughput_mbps
        if prb_util > 80:
            degradation = 1.0 - 0.6 * ((prb_util - 80) / 20) ** 2
        else:
            degradation = 1.0
        throughput = float(max(0.0, raw_tp * degradation +
                               self._rng.gauss(0, raw_tp * 0.02)))

        # ── SINR (dB) ────────────────────────────────────
        # Base 20 dB, minus own-load penalty, minus neighbour interference,
        # minus energy-mode penalty
        own_penalty      = 10 * (prb_util / 100) ** 1.5
        neighbour_load   = self._avg_neighbour_load(cell, state)
        interference     = 8 * neighbour_load
        mode_penalty     = 6.0 if cell.energy_mode == EnergyMode.SLEEP else 0.0
        sinr_db = float(20.0 - own_penalty - interference - mode_penalty
                        + self._rng.gauss(0, 0.3))

        # ── CQI ──────────────────────────────────────────
        cqi = _sinr_to_cqi(sinr_db)

        # ── Latency p95 (ms) ─────────────────────────────
        # Base 5ms + quadratic queuing above 70% PRB + backhaul delay
        if prb_util > 70:
            queuing = 30 * ((prb_util - 70) / 30) ** 2
        else:
            queuing = 0.0
        latency_p95 = float(5.0 + queuing + bh.delay_ms
                            + self._rng.gauss(0, 0.5))

        # ── Packet loss (%) ──────────────────────────────
        # Near-zero below 90% PRB; quadratic above + backhaul loss
        if prb_util > 90:
            radio_loss = 5.0 * ((prb_util - 90) / 10) ** 2
        else:
            radio_loss = self._rng.uniform(0.0, 0.2)
        packet_loss = float(min(20.0, radio_loss + bh.loss_pct))

        # ── CPU load (%) ─────────────────────────────────
        ues_on_cell  = sum(1 for u in state.ues.values()
                          if u.serving_cell == cell.cell_id)
        max_ues      = 30   # capacity reference
        cpu_load = float(min(100.0,
            (ues_on_cell / max_ues) * 50
            + prb_util * 0.4
            + self._rng.gauss(0, 1.5)
        ))

        # ── Handover fail rate ────────────────────────────
        if cell.ho_attempts > 0:
            ho_fail_rate = cell.ho_failures / cell.ho_attempts
        else:
            ho_fail_rate = 0.0

        # ── SLA violation ────────────────────────────────
        # Find tightest SLA latency among slices on this cell
        slice_slas  = [s.sla_latency_ms for s in state.slices.values()]
        sla_latency = min(slice_slas) if slice_slas else 50.0
        sla_violation = bool(
            prb_util > 95.0
            or sinr_db < 0.0
            or latency_p95 > sla_latency
        )

        ts = datetime.now(timezone.utc).isoformat()

        kpi = {
            "cell_id":         cell.cell_id,
            "ts":              ts,
            "sim_time_s":      state.sim_time_s,
            "tick":            tick,
            "is_peak":         is_peak,
            "prb_util":        round(prb_util, 2),
            "throughput_mbps": round(throughput, 2),
            "sinr_db":         round(sinr_db, 2),
            "cqi":             cqi,
            "latency_p95_ms":  round(latency_p95, 2),
            "packet_loss_pct": round(packet_loss, 3),
            "cpu_load_pct":    round(cpu_load, 2),
            "ho_fail_rate":    round(ho_fail_rate, 4),
            "energy_mode":     cell.energy_mode.value,
            "sla_violation":   sla_violation,
        }
        return kpi

    # ── Helpers ─────────────────────────────────────────────────────

    def _avg_neighbour_load(self, cell: "Cell", state: "WorldState") -> float:
        if not cell.neighbours:
            return 0.0
        loads = [state.cells[n].current_load
                 for n in cell.neighbours if n in state.cells]
        return sum(loads) / len(loads) if loads else 0.0
