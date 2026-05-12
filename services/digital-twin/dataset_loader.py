"""
AURA-NET Digital Twin — dataset_loader.py
Ticket: AN-TWN-001

Loads the Italian Telecom 2013 dataset and produces a
load_factor[cell_id][tick_index] lookup that drives the simulation.

Dataset: https://www.kaggle.com/datasets/ocanaydin/italian-telecom-data-2013-1week
Expected CSV columns: CellID, datetime, smsin, smsout, callin, callout, internet

If the dataset is unavailable, a synthetic fallback is generated
that mimics realistic diurnal patterns so development can proceed.
"""
from __future__ import annotations

import os
import math
import random
from pathlib import Path
from typing import Dict, List

import numpy as np

# Map our 12 simulation cells to real CellIDs from the dataset.
# These IDs cover a mix of city-centre and residential cells in Milan.
CELL_TO_DATASET_ID: Dict[str, int] = {
    "C00": 4455, "C01": 4456, "C02": 4553, "C03": 4554,
    "C10": 5055, "C11": 5056, "C12": 5153, "C13": 5154,
    "C20": 5555, "C21": 5556, "C22": 5653, "C23": 5654,
}

# How many 5-second ticks fit in one 10-minute dataset interval
TICKS_PER_INTERVAL = 120   # 600s / 5s


class DatasetLoader:
    """
    Produces load_factor values in [0.0, 1.0] for each cell at each tick.
    Adds per-tick Gaussian noise on top of the 10-minute baseline.
    """

    def __init__(self, csv_path: str = "/data/telecom.csv", seed: int = 42) -> None:
        self.rng = random.Random(seed)
        np.random.seed(seed)

        self._load_factors: Dict[str, List[float]] = {}  # cell_id → list of floats (one per interval)
        self._tick_cache:   Dict[str, List[float]] = {}  # cell_id → expanded tick list

        csv = Path(csv_path)
        if csv.exists():
            self._load_from_csv(csv)
        else:
            print(f"[DatasetLoader] CSV not found at {csv_path} — using synthetic diurnal fallback")
            self._generate_synthetic()

        self._expand_to_ticks()

    # ── CSV loading ─────────────────────────────────────────────────

    def _load_from_csv(self, path: Path) -> None:
        try:
            import pandas as pd
            df = pd.read_csv(path)
            df.columns = [c.strip().lower() for c in df.columns]
            df = df[["cellid", "datetime", "internet"]].copy()
            df["datetime"] = pd.to_datetime(df["datetime"])
            df = df.sort_values("datetime")

            for sim_cell, ds_id in CELL_TO_DATASET_ID.items():
                cell_df = df[df["cellid"] == ds_id]["internet"].fillna(0).values
                if len(cell_df) == 0:
                    self._load_factors[sim_cell] = self._synthetic_diurnal(sim_cell)
                    continue
                # min-max normalise to [0.05, 0.95]
                mn, mx = cell_df.min(), cell_df.max()
                if mx == mn:
                    normalised = np.full(len(cell_df), 0.3)
                else:
                    normalised = 0.05 + 0.90 * (cell_df - mn) / (mx - mn)
                self._load_factors[sim_cell] = normalised.tolist()
            print(f"[DatasetLoader] Loaded {len(df)} rows from {path}")
        except Exception as e:
            print(f"[DatasetLoader] CSV parse error: {e} — falling back to synthetic")
            self._generate_synthetic()

    # ── Synthetic fallback ──────────────────────────────────────────

    def _generate_synthetic(self) -> None:
        for cell_id in CELL_TO_DATASET_ID:
            self._load_factors[cell_id] = self._synthetic_diurnal(cell_id)

    def _synthetic_diurnal(self, cell_id: str) -> List[float]:
        """
        1008 intervals = 7 days × 144 intervals/day (10-min each).
        City-centre cells: peak 18:00-22:00.
        Residential cells: softer peak 20:00-23:00.
        Row 0 = city centre, Row 2 = residential.
        """
        row = int(cell_id[1])
        peak_hour = 19 if row == 0 else 21
        base_load = 0.3 + row * 0.05

        intervals = []
        for day in range(7):
            for interval in range(144):   # 144 × 10min = 24h
                hour = interval / 6       # 0..23.83
                # double Gaussian: morning bump + evening peak
                morning = 0.15 * math.exp(-0.5 * ((hour - 9) / 1.5) ** 2)
                evening = 0.50 * math.exp(-0.5 * ((hour - peak_hour) / 2.0) ** 2)
                # weekend dip
                weekend = 0.85 if day >= 5 else 1.0
                load = min(0.95, max(0.05, base_load + morning + evening) * weekend)
                # small random variation per cell
                noise = self.rng.gauss(0, 0.02)
                intervals.append(float(np.clip(load + noise, 0.05, 0.95)))

        return intervals

    # ── Expand to per-tick ──────────────────────────────────────────

    def _expand_to_ticks(self) -> None:
        """
        Each 10-minute interval expands to TICKS_PER_INTERVAL ticks.
        Adds Gaussian noise per tick so KPIs vary within each interval.
        """
        for cell_id, intervals in self._load_factors.items():
            ticks = []
            for base in intervals:
                for _ in range(TICKS_PER_INTERVAL):
                    noise = self.rng.gauss(0, 0.015)
                    ticks.append(float(np.clip(base + noise, 0.02, 0.98)))
            self._tick_cache[cell_id] = ticks

    # ── Public API ──────────────────────────────────────────────────

    def get_load_factor(self, cell_id: str, tick: int) -> float:
        """
        Returns the load_factor for a given cell at a given simulation tick.
        Wraps around after 7 days (1008 intervals × 120 ticks = 120960 ticks).
        """
        ticks = self._tick_cache.get(cell_id)
        if not ticks:
            return 0.3
        return ticks[tick % len(ticks)]

    def is_peak_hour(self, tick: int) -> bool:
        """True if current sim tick falls in 08:00-22:00 window."""
        ticks_per_day  = 144 * TICKS_PER_INTERVAL
        tick_in_day    = tick % ticks_per_day
        ticks_per_hour = 6 * TICKS_PER_INTERVAL
        hour = tick_in_day / ticks_per_hour
        return 8.0 <= hour < 22.0
