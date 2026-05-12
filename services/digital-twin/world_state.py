"""
AURA-NET Digital Twin — world_state.py
Ticket: AN-TWN-001

Defines every entity in the simulated 5G RAN:
  Cell / gNodeB, NetworkSlice, UE, BackhaulLink, WorldState
"""
from __future__ import annotations
import copy
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional


# ── Enums ──────────────────────────────────────────────────────────

class EnergyMode(str, Enum):
    ACTIVE   = "ACTIVE"
    SLEEP    = "SLEEP"
    SHUTDOWN = "SHUTDOWN"

class LinkStatus(str, Enum):
    UP         = "UP"
    DEGRADED   = "DEGRADED"
    DOWN       = "DOWN"


# ── BackhaulLink ────────────────────────────────────────────────────

@dataclass
class BackhaulLink:
    cell_id:    str
    delay_ms:   float = 5.0      # baseline backhaul delay
    loss_pct:   float = 0.1      # baseline packet loss %
    status:     LinkStatus = LinkStatus.UP

    def degrade(self, delay_ms: float, loss_pct: float) -> None:
        self.delay_ms = delay_ms
        self.loss_pct = loss_pct
        self.status   = LinkStatus.DEGRADED

    def restore(self) -> None:
        self.delay_ms = 5.0
        self.loss_pct = 0.1
        self.status   = LinkStatus.UP

    def to_dict(self) -> dict:
        return {
            "cell_id":  self.cell_id,
            "delay_ms": self.delay_ms,
            "loss_pct": self.loss_pct,
            "status":   self.status.value,
        }


# ── NetworkSlice ────────────────────────────────────────────────────

@dataclass
class NetworkSlice:
    slice_id:    str
    priority:    int            # 1 = highest (premium), 9 = lowest (IoT)
    min_bw_pct:  float = 10.0  # minimum guaranteed PRB share (%)
    max_bw_pct:  float = 80.0  # maximum allowed PRB share (%)
    sla_latency_ms: float = 50.0

    # runtime
    current_load: float = 0.0  # 0.0–1.0

    def to_dict(self) -> dict:
        return {
            "slice_id":        self.slice_id,
            "priority":        self.priority,
            "min_bw_pct":      self.min_bw_pct,
            "max_bw_pct":      self.max_bw_pct,
            "sla_latency_ms":  self.sla_latency_ms,
            "current_load":    round(self.current_load, 4),
        }


# ── UE (User Equipment) ─────────────────────────────────────────────

@dataclass
class UE:
    ue_id:       str
    serving_cell: str
    slice_id:    str
    speed_kmh:   float = 30.0   # mobility speed

    # runtime
    x: float = 0.0
    y: float = 0.0

    def to_dict(self) -> dict:
        return {
            "ue_id":        self.ue_id,
            "serving_cell": self.serving_cell,
            "slice_id":     self.slice_id,
            "speed_kmh":    self.speed_kmh,
        }


# ── Cell / gNodeB ───────────────────────────────────────────────────

@dataclass
class Cell:
    cell_id:       str
    max_prb:       int   = 100    # max Physical Resource Blocks
    max_throughput_mbps: float = 1000.0
    neighbours:    List[str] = field(default_factory=list)
    energy_mode:   EnergyMode = EnergyMode.ACTIVE

    # runtime — set each tick by KpiSynthesizer
    current_load:  float = 0.0   # 0.0–1.0, driven by dataset load_factor
    a3_offset:     float = 3.0   # handover A3 offset (dB)
    ttt_ms:        float = 40.0  # time-to-trigger (ms)

    # handover counters (reset each tick)
    ho_attempts:   int = 0
    ho_failures:   int = 0

    @property
    def effective_prb(self) -> int:
        """PRB capacity after applying energy mode penalty."""
        if self.energy_mode == EnergyMode.ACTIVE:
            return self.max_prb
        elif self.energy_mode == EnergyMode.SLEEP:
            return int(self.max_prb * 0.3)
        else:  # SHUTDOWN
            return 0

    @property
    def prb_utilization(self) -> float:
        """0–100 %"""
        if self.effective_prb == 0:
            return 100.0
        return min(100.0, (self.current_load * self.max_prb) / self.effective_prb * 100)

    def to_dict(self) -> dict:
        return {
            "cell_id":       self.cell_id,
            "max_prb":       self.max_prb,
            "effective_prb": self.effective_prb,
            "energy_mode":   self.energy_mode.value,
            "neighbours":    self.neighbours,
            "current_load":  round(self.current_load, 4),
            "a3_offset":     self.a3_offset,
            "ttt_ms":        self.ttt_ms,
            "ho_attempts":   self.ho_attempts,
            "ho_failures":   self.ho_failures,
        }


# ── WorldState ──────────────────────────────────────────────────────

class WorldState:
    """
    Single source of truth for the entire simulated network.
    The SimPy simulation reads and mutates this object every tick.
    The FastAPI layer reads it (never mutates directly).
    """

    def __init__(self) -> None:
        self.cells:   Dict[str, Cell]         = {}
        self.slices:  Dict[str, NetworkSlice] = {}
        self.ues:     Dict[str, UE]           = {}
        self.backhaul: Dict[str, BackhaulLink] = {}

        # simulation clock (seconds since sim start)
        self.sim_time_s: float = 0.0
        self.wall_time:  float = time.time()

        # recent KPI snapshots — ring buffer, last 60 ticks per cell
        self._kpi_history: Dict[str, List[dict]] = {}

        # change records — populated by ActionManager
        self.change_records: Dict[str, dict] = {}

        self._build_topology()

    # ── topology bootstrap ──────────────────────────────────────────

    def _build_topology(self) -> None:
        """
        Create a 3×4 grid of 12 cells with slice and backhaul assignments.
        Each row shares one backhaul segment.
        """
        # Define 3 slices
        self.slices = {
            "slice-premium":  NetworkSlice("slice-premium",  priority=1, min_bw_pct=20, max_bw_pct=80, sla_latency_ms=20),
            "slice-standard": NetworkSlice("slice-standard", priority=5, min_bw_pct=10, max_bw_pct=70, sla_latency_ms=50),
            "slice-iot":      NetworkSlice("slice-iot",      priority=9, min_bw_pct=5,  max_bw_pct=40, sla_latency_ms=200),
        }

        # 3×4 grid — cell IDs C00..C11
        grid = {}
        for row in range(3):
            for col in range(4):
                cid = f"C{row}{col}"
                grid[(row, col)] = cid

        for (row, col), cid in grid.items():
            # neighbours: up/down/left/right
            nbrs = []
            for dr, dc in [(-1,0),(1,0),(0,-1),(0,1)]:
                npos = (row+dr, col+dc)
                if npos in grid:
                    nbrs.append(grid[npos])

            self.cells[cid] = Cell(
                cell_id=cid,
                max_prb=100,
                max_throughput_mbps=1000.0,
                neighbours=nbrs,
            )
            self.backhaul[cid] = BackhaulLink(cell_id=cid)

        # Assign 10 UEs per cell (120 total)
        slice_ids = ["slice-premium", "slice-standard", "slice-iot"]
        for cid in self.cells:
            for i in range(10):
                uid = f"UE-{cid}-{i:02d}"
                self.ues[uid] = UE(
                    ue_id=uid,
                    serving_cell=cid,
                    slice_id=slice_ids[i % 3],
                    speed_kmh=30.0 + (i * 5),
                )
                if uid not in self._kpi_history:
                    self._kpi_history[cid] = []

        # init kpi_history keys
        for cid in self.cells:
            self._kpi_history[cid] = []

    # ── KPI history helpers ─────────────────────────────────────────

    def push_kpi(self, cell_id: str, kpi: dict) -> None:
        buf = self._kpi_history.setdefault(cell_id, [])
        buf.append(kpi)
        if len(buf) > 60:
            buf.pop(0)

    def get_kpi_history(self, cell_id: str, last_n: int = 10) -> List[dict]:
        return self._kpi_history.get(cell_id, [])[-last_n:]

    def get_all_latest_kpis(self) -> List[dict]:
        result = []
        for cid in self.cells:
            hist = self._kpi_history.get(cid, [])
            if hist:
                result.append(hist[-1])
        return result

    # ── snapshot / clone ────────────────────────────────────────────

    def snapshot(self) -> dict:
        return {
            "sim_time_s": self.sim_time_s,
            "cells":   {k: v.to_dict() for k, v in self.cells.items()},
            "slices":  {k: v.to_dict() for k, v in self.slices.items()},
            "backhaul":{k: v.to_dict() for k, v in self.backhaul.items()},
        }

    def clone(self) -> "WorldState":
        """Deep copy for what-if simulation."""
        return copy.deepcopy(self)

    # ── topology query ──────────────────────────────────────────────

    def get_topology(self, entity_id: Optional[str] = None) -> dict:
        if entity_id and entity_id in self.cells:
            cell = self.cells[entity_id]
            return {
                "entity_id": entity_id,
                "type": "cell",
                "neighbours": cell.neighbours,
                "backhaul": self.backhaul[entity_id].to_dict(),
                "energy_mode": cell.energy_mode.value,
            }
        # full topology
        return {
            "cells": {k: v.to_dict() for k, v in self.cells.items()},
            "backhaul": {k: v.to_dict() for k, v in self.backhaul.items()},
            "slices": {k: v.to_dict() for k, v in self.slices.items()},
            "ue_count": len(self.ues),
        }
