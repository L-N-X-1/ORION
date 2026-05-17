"""
AURA-NET Digital Twin — fault_injector.py
Ticket: AN-TWN-001

Provides named scenario scripts that inject faults into WorldState.
Used by the /fault endpoint and by AN-TST-001 scenario tests.

Scenarios:
  - evening_congestion        : spike load on 3 adjacent cells
  - backhaul_degradation      : degrade backhaul link on a cell
  - mobility_storm            : set near-zero A3 offset on a cell
  - policy_misconfiguration   : invert slice priorities
  - energy_saving_failure     : apply SLEEP during peak load
"""
from __future__ import annotations

from typing import TYPE_CHECKING




if TYPE_CHECKING:
    from world_state import WorldState


class FaultInjector:

    # ── Scenarios ───────────────────────────────────────────────────

    @staticmethod
    def evening_congestion(state: "WorldState",
                           cells: list[str] | None = None) -> dict:
        """Spike load to 0.98 on 3 adjacent cells (default C00, C01, C10)."""
        targets = cells or ["C00", "C01", "C10"]
        for cid in targets:
            if cid in state.cells:
                state.cells[cid].current_load = 0.98
                state.pinned_loads[cid] = 0.98
        return {"scenario": "evening_congestion", "targets": targets, "load": 0.98}

    @staticmethod
    def backhaul_degradation(state: "WorldState",
                             cell_id: str = "C00",
                             delay_ms: float = 150.0,
                             loss_pct: float = 5.0) -> dict:
        """Degrade the backhaul link for a specific cell."""
        if cell_id in state.backhaul:
            state.backhaul[cell_id].degrade(delay_ms, loss_pct)
        return {
            "scenario": "backhaul_degradation",
            "cell_id": cell_id,
            "delay_ms": delay_ms,
            "loss_pct": loss_pct,
        }

    @staticmethod
    def mobility_storm(state: "WorldState",
                       cell_id: str = "C11",
                       a3_offset: float = 0.1) -> dict:
        """Set near-zero A3 offset to trigger excessive handover attempts."""
        if cell_id in state.cells:
            state.cells[cell_id].a3_offset = a3_offset
        return {"scenario": "mobility_storm", "cell_id": cell_id, "a3_offset": a3_offset}

    @staticmethod
    def policy_misconfiguration(state: "WorldState") -> dict:
        """Invert slice priorities so IoT gets premium resources."""
        if "slice-premium" in state.slices and "slice-iot" in state.slices:
            state.slices["slice-premium"].priority = 9
            state.slices["slice-iot"].priority     = 1
        return {"scenario": "policy_misconfiguration"}

    @staticmethod
    def energy_saving_failure(state: "WorldState",
                              cell_id: str = "C20") -> dict:
        """Apply SLEEP mode during peak load, causing PRB overflow."""
        from world_state import EnergyMode
        if cell_id in state.cells:
            state.cells[cell_id].energy_mode = EnergyMode.SLEEP
            state.cells[cell_id].current_load = 0.95
        return {"scenario": "energy_saving_failure", "cell_id": cell_id}

    # ── Restore helpers ─────────────────────────────────────────────

    @staticmethod
    def restore_backhaul(state: "WorldState", cell_id: str = "C00") -> dict:
        if cell_id in state.backhaul:
            state.backhaul[cell_id].restore()
        return {"restored": "backhaul", "cell_id": cell_id}

    @staticmethod
    def restore_energy_mode(state: "WorldState", cell_id: str = "C20") -> dict:
        from world_state import EnergyMode
        if cell_id in state.cells:
            state.cells[cell_id].energy_mode = EnergyMode.ACTIVE
        return {"restored": "energy_mode", "cell_id": cell_id}

    @staticmethod
    def restore_slice_priorities(state: "WorldState") -> dict:
        if "slice-premium" in state.slices and "slice-iot" in state.slices:
            state.slices["slice-premium"].priority = 1
            state.slices["slice-iot"].priority     = 9
        return {"restored": "slice_priorities"}

    @staticmethod
    def restore_handover_params(state: "WorldState", cell_id: str = "C11") -> dict:
        if cell_id in state.cells:
            state.cells[cell_id].a3_offset = 3.0
            state.cells[cell_id].ttt_ms    = 40.0
        return {"restored": "handover_params", "cell_id": cell_id}
    
    @staticmethod
    def restore_evening_congestion(state: "WorldState", cells: list[str] | None = None) -> dict:
        targets = cells or ["C00", "C01", "C10"]
        for cid in targets:
            state.pinned_loads.pop(cid, None)   # ← release pin
        return {"restored": "evening_congestion", "targets": targets}
