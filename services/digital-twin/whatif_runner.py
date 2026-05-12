"""
AURA-NET Digital Twin — whatif_runner.py
Ticket: AN-AGT-007

Clones the current WorldState, applies an action plan on the clone,
runs the SimPy simulation forward for a defined horizon, then
returns a delta forecast (baseline vs. with-action KPI comparison).

Used by: Planner Agent via POST /whatif/run
"""
from __future__ import annotations

import simpy
from typing import TYPE_CHECKING, Any

from kpi_synthesizer import KpiSynthesizer
from mobility import MobilityProcess
from dataset_loader import DatasetLoader

if TYPE_CHECKING:
    from world_state import WorldState


TICK_INTERVAL_S = 5      # seconds per tick
DEFAULT_HORIZON = 120    # ticks to simulate forward (~10 minutes)


class WhatIfRunner:

    def __init__(self, dataset: DatasetLoader) -> None:
        self._dataset   = dataset
        self._synth     = KpiSynthesizer(seed=99)
        self._mobility  = MobilityProcess(seed=99)

    # ── Public API ──────────────────────────────────────────────────

    def run(self, live_state: "WorldState",
            action_plan: dict,
            horizon_ticks: int = DEFAULT_HORIZON) -> dict:
        """
        1. Clone the live WorldState.
        2. Apply action_plan on the clone (baseline run with NO actions).
        3. Also run a clone WITH the action applied.
        4. Compare KPI averages over the horizon.
        Returns a DeltaForecastReport dict.
        """
        # baseline: no action
        baseline_clone = live_state.clone()
        baseline_kpis  = self._simulate(baseline_clone, horizon_ticks, action_plan=None)

        # with-action
        action_clone  = live_state.clone()
        self._apply_action(action_clone, action_plan)
        action_kpis   = self._simulate(action_clone, horizon_ticks, action_plan=None)

        return self._build_report(action_plan, baseline_kpis, action_kpis, horizon_ticks)

    # ── Simulation ──────────────────────────────────────────────────

    def _simulate(self, state: "WorldState",
                  horizon_ticks: int,
                  action_plan: Any) -> dict[str, list[dict]]:
        """
        Runs a SimPy environment for horizon_ticks ticks on the cloned state.
        Returns dict[cell_id → list of kpi dicts].
        """
        kpi_log: dict[str, list[dict]] = {cid: [] for cid in state.cells}
        start_tick = int(state.sim_time_s / TICK_INTERVAL_S)

        env = simpy.Environment()

        def tick_process(env):
            for i in range(horizon_ticks):
                tick = start_tick + i
                is_peak = self._dataset.is_peak_hour(tick)

                # Update loads from dataset
                for cid, cell in state.cells.items():
                    cell.current_load = self._dataset.get_load_factor(cid, tick)

                self._mobility.run_tick(state)
                kpis = self._synth.synthesize(state, tick, is_peak)
                state.sim_time_s += TICK_INTERVAL_S

                for kpi in kpis:
                    kpi_log[kpi["cell_id"]].append(kpi)

                yield env.timeout(1)

        env.process(tick_process(env))
        env.run()
        return kpi_log

    # ── Action application ──────────────────────────────────────────

    def _apply_action(self, state: "WorldState", action_plan: dict) -> None:
        """Apply the action to the cloned state before simulating."""
        action_type = action_plan.get("action_type")

        if action_type == "apply_slice_policy":
            p = action_plan.get("params", {})
            sid = p.get("slice_id")
            if sid and sid in state.slices:
                if "min_bw_pct" in p:
                    state.slices[sid].min_bw_pct = p["min_bw_pct"]
                if "max_bw_pct" in p:
                    state.slices[sid].max_bw_pct = p["max_bw_pct"]
                if "priority" in p:
                    state.slices[sid].priority = p["priority"]

        elif action_type == "tune_handover":
            p = action_plan.get("params", {})
            cid = p.get("cell_id")
            if cid and cid in state.cells:
                if "a3_offset" in p:
                    state.cells[cid].a3_offset = p["a3_offset"]
                if "ttt_ms" in p:
                    state.cells[cid].ttt_ms = p["ttt_ms"]

        elif action_type == "enable_energy_saving":
            p = action_plan.get("params", {})
            cid  = p.get("cell_id")
            mode = p.get("mode", "ACTIVE")
            if cid and cid in state.cells:
                from world_state import EnergyMode
                state.cells[cid].energy_mode = EnergyMode(mode)

    # ── Delta report ────────────────────────────────────────────────

    def _build_report(self, action_plan: dict,
                      baseline: dict[str, list[dict]],
                      with_action: dict[str, list[dict]],
                      horizon_ticks: int) -> dict:

        def avg(kpi_list, key):
            vals = [k[key] for k in kpi_list if key in k]
            return round(sum(vals) / len(vals), 3) if vals else 0.0

        cells_affected = action_plan.get("affected_cells",
                         list(baseline.keys()))

        summary = []
        for cid in cells_affected:
            b = baseline.get(cid, [])
            a = with_action.get(cid, [])
            if not b or not a:
                continue
            summary.append({
                "cell_id": cid,
                "baseline": {
                    "prb_util":        avg(b, "prb_util"),
                    "throughput_mbps": avg(b, "throughput_mbps"),
                    "latency_p95_ms":  avg(b, "latency_p95_ms"),
                    "packet_loss_pct": avg(b, "packet_loss_pct"),
                    "sla_violations":  sum(1 for k in b if k.get("sla_violation")),
                },
                "with_action": {
                    "prb_util":        avg(a, "prb_util"),
                    "throughput_mbps": avg(a, "throughput_mbps"),
                    "latency_p95_ms":  avg(a, "latency_p95_ms"),
                    "packet_loss_pct": avg(a, "packet_loss_pct"),
                    "sla_violations":  sum(1 for k in a if k.get("sla_violation")),
                },
                "delta": {
                    "prb_util":        round(avg(a,"prb_util") - avg(b,"prb_util"), 3),
                    "throughput_mbps": round(avg(a,"throughput_mbps") - avg(b,"throughput_mbps"), 3),
                    "latency_p95_ms":  round(avg(a,"latency_p95_ms") - avg(b,"latency_p95_ms"), 3),
                    "packet_loss_pct": round(avg(a,"packet_loss_pct") - avg(b,"packet_loss_pct"), 3),
                },
            })

        # overall: did SLA violations improve?
        total_sla_baseline = sum(r["baseline"]["sla_violations"] for r in summary)
        total_sla_action   = sum(r["with_action"]["sla_violations"] for r in summary)
        improvement        = total_sla_baseline - total_sla_action

        return {
            "action_plan":       action_plan,
            "horizon_ticks":     horizon_ticks,
            "horizon_minutes":   round(horizon_ticks * TICK_INTERVAL_S / 60, 1),
            "cells_analysed":    len(summary),
            "overall": {
                "sla_violations_baseline": total_sla_baseline,
                "sla_violations_action":   total_sla_action,
                "sla_improvement":         improvement,
                "confidence":              self._confidence(improvement, horizon_ticks),
            },
            "per_cell": summary,
        }

    def _confidence(self, improvement: int, horizon: int) -> float:
        """Simple heuristic: more improvement over longer horizon = higher confidence."""
        if horizon == 0:
            return 0.0
        raw = min(1.0, improvement / max(horizon * 0.1, 1))
        return round(max(0.0, raw), 2)
