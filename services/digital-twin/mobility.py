"""
AURA-NET Digital Twin — mobility.py
Ticket: AN-TWN-001

Simulates UE mobility and handover attempts.
When a cell is overloaded (PRB > 80%), UEs probabilistically
attempt handovers to the least-loaded neighbour.
"""
from __future__ import annotations

import random
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from world_state import WorldState


class MobilityProcess:

    def __init__(self, seed: int = 42) -> None:
        self._rng = random.Random(seed)

    def run_tick(self, state: "WorldState") -> None:
        """
        Called once per simulation tick.
        Evaluates handover eligibility for every UE.
        """
        for cell_id, cell in state.cells.items():
            # Reset counters each tick
            cell.ho_attempts = 0
            cell.ho_failures  = 0

        for ue in state.ues.values():
            self._evaluate_handover(ue, state)

    def _evaluate_handover(self, ue, state: "WorldState") -> None:
        from world_state import EnergyMode

        serving = state.cells.get(ue.serving_cell)
        if not serving:
            return

        # Trigger handover when PRB > 80% or cell is being shut down
        prb = serving.prb_utilization
        forced = serving.energy_mode == EnergyMode.SHUTDOWN
        if prb < 80.0 and not forced:
            return

        best_neighbour = self._find_best_neighbour(ue, serving, state)
        if best_neighbour is None:
            return

        serving.ho_attempts += 1

        # Failure probability rises with: low A3 offset, high neighbour load,
        # high current PRB, or small TTT
        failure_prob = 0.05
        if serving.a3_offset < 1.0:
            failure_prob += 0.25
        if prb > 95:
            failure_prob += 0.15
        if state.cells[best_neighbour].prb_utilization > 85:
            failure_prob += 0.20

        if self._rng.random() < failure_prob:
            serving.ho_failures += 1
        else:
            # Successful handover — move UE
            ue.serving_cell = best_neighbour

    def _find_best_neighbour(self, ue, serving, state: "WorldState"):
        from world_state import EnergyMode
        candidates = [
            (n, state.cells[n].prb_utilization)
            for n in serving.neighbours
            if n in state.cells
            and state.cells[n].energy_mode != EnergyMode.SHUTDOWN
        ]
        if not candidates:
            return None
        # pick the neighbour with the lowest PRB
        candidates.sort(key=lambda x: x[1])
        return candidates[0][0]
