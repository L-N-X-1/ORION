"""
AURA-NET Digital Twin — dataset_loader.py
Ticket: AN-TWN-001

Auto-discovers and merges all CSV files in DATASET_DIR, then maps
per-cell demand curves to the 12 simulation cells.

Environment variables:
  DATASET_DIR     : folder containing CSV files (default: /data/telecom)
                    All .csv files in this folder are loaded and merged automatically.

  DATASET_SOURCES : optional per-cell overrides (takes priority over auto-discovery)
                    Format: cell_id:csv_path:id_column:id_value:value_column
                    Separate entries with |

Supported CSV format (Italian Telecom 2013 and compatible):
  Columns: CellID, Datetime, smsin, smsout, callin, callout, internet

Cell to CellID mapping (Milan grid):
  Row 0 (city centre) : C00=4455  C01=4456  C02=4553  C03=4554
  Row 1 (mixed)       : C10=5055  C11=5056  C12=5153  C13=5154
  Row 2 (residential) : C20=5555  C21=5556  C22=5653  C23=5654
"""
from __future__ import annotations

import math
import os
import random
from pathlib import Path
from typing import TYPE_CHECKING, Dict, List, Optional

import numpy as np

# Import pandas type only for type checking — avoids runtime import issues
if TYPE_CHECKING:
    import pandas as pd
    DataFrame = pd.DataFrame
else:
    DataFrame = None


# ── Cell to dataset CellID mapping ──────────────────────────────────

CELL_TO_DATASET_ID: Dict[str, int] = {
    "C00": 4455, "C01": 4456, "C02": 4553, "C03": 4554,
    "C10": 5055, "C11": 5056, "C12": 5153, "C13": 5154,
    "C20": 5555, "C21": 5556, "C22": 5653, "C23": 5654,
}

ALL_CELL_IDS = list(CELL_TO_DATASET_ID.keys())

TICKS_PER_INTERVAL = 120   # 5s ticks per 10-min dataset interval


# ── Per-cell source override ─────────────────────────────────────────

class CellSourceOverride:
    def __init__(self, cell_id: str, csv_path: str,
                 id_column: str, id_value: str, value_column: str) -> None:
        self.cell_id      = cell_id
        self.csv_path     = csv_path
        self.id_column    = id_column
        self.id_value     = id_value
        self.value_column = value_column

    @staticmethod
    def parse_env(raw: str) -> Dict[str, "CellSourceOverride"]:
        result: Dict[str, CellSourceOverride] = {}
        for entry in raw.split("|"):
            entry = entry.strip()
            if not entry:
                continue
            parts = entry.split(":")
            if len(parts) != 5:
                print(f"[DatasetLoader] Skipping bad DATASET_SOURCES entry: '{entry}'")
                continue
            src = CellSourceOverride(*parts)
            result[src.cell_id] = src
        return result


# ── Main loader ──────────────────────────────────────────────────────

class DatasetLoader:

    def __init__(self, seed: int = 42) -> None:
        self.rng = random.Random(seed)
        np.random.seed(seed)

        self._load_factors: Dict[str, List[float]] = {}
        self._tick_cache:   Dict[str, List[float]] = {}
        self._source_info:  Dict[str, str]         = {}

        self._dataset_dir = os.getenv("DATASET_DIR", "/data/telecom")
        overrides_raw     = os.getenv("DATASET_SOURCES", "").strip()
        self._overrides   = CellSourceOverride.parse_env(overrides_raw) if overrides_raw else {}

        # _df is explicitly typed — Pylance now knows it's either a DataFrame or None
        self._df: Optional["pd.DataFrame"] = self._load_all_csvs(self._dataset_dir)

        for cell_id in ALL_CELL_IDS:
            if cell_id in self._overrides:
                self._load_from_override(cell_id, self._overrides[cell_id])
            elif self._df is not None:
                # Guard: only enter this branch when _df is confirmed not None
                self._load_from_merged(cell_id, self._df)
            else:
                self._use_synthetic(cell_id)

        self._expand_to_ticks()
        self._print_summary()

    # ── Folder auto-discovery ────────────────────────────────────────

    def _load_all_csvs(self, folder: str) -> "Optional[pd.DataFrame]":
        try:
            import pandas as pd
        except ImportError:
            print("[DatasetLoader] pandas not installed — using synthetic fallback")
            return None

        path = Path(folder)
        if not path.exists():
            print(f"[DatasetLoader] DATASET_DIR '{folder}' not found — using synthetic fallback")
            return None

        csv_files = sorted(path.glob("*.csv"))
        if not csv_files:
            print(f"[DatasetLoader] No CSV files found in '{folder}' — using synthetic fallback")
            return None

        print(f"[DatasetLoader] Found {len(csv_files)} CSV file(s) in '{folder}':")
        frames: list["pd.DataFrame"] = []
        for f in csv_files:
            try:
                df = pd.read_csv(f, low_memory=False)
                df.columns = pd.Index([c.strip().lower() for c in df.columns])
                frames.append(df)
                print(f"  + {f.name}  ({len(df):,} rows)")
            except Exception as e:
                print(f"  x {f.name}  ERROR: {e}")

        if not frames:
            return None

        merged: "pd.DataFrame" = pd.concat(frames, ignore_index=True)

        dt_candidates = [
            c for c in merged.columns
            if any(k in c for k in ["datetime", "date", "time", "ts"])
        ]
        if dt_candidates:
            merged[dt_candidates[0]] = pd.to_datetime(
                merged[dt_candidates[0]], errors="coerce"
            )
            merged = merged.sort_values(dt_candidates[0])

        print(f"[DatasetLoader] Merged total: {len(merged):,} rows across {len(csv_files)} files")
        return merged

    # ── Load from merged DataFrame ───────────────────────────────────
    # Note: df is passed explicitly so Pylance knows it is never None here

    def _load_from_merged(self, cell_id: str, df: "pd.DataFrame") -> None:
        import pandas as pd

        dataset_id = CELL_TO_DATASET_ID[cell_id]

        id_col: Optional[str] = next(
            (c for c in df.columns
             if c.replace("_", "").replace("-", "") == "cellid"),
            None,
        )

        if id_col is None:
            print(f"[DatasetLoader] {cell_id}: no CellID column found — using synthetic")
            self._use_synthetic(cell_id)
            return

        cell_df = df[df[id_col] == dataset_id]
        if cell_df.empty:
            cell_df = df[df[id_col].astype(str) == str(dataset_id)]

        if cell_df.empty:
            print(f"[DatasetLoader] {cell_id}: CellID {dataset_id} not in data — using synthetic")
            self._use_synthetic(cell_id)
            return

        value_col = self._pick_value_column(cell_df)
        if value_col is None:
            self._use_synthetic(cell_id)
            return

        values = (
            pd.to_numeric(cell_df[value_col], errors="coerce")
            .fillna(0)
            .to_numpy(dtype=float)
        )
        self._load_factors[cell_id] = self._normalise(values)
        self._source_info[cell_id]  = f"real ({value_col}, {len(values)} rows)"

    # ── Load from explicit override ───────────────────────────────────

    def _load_from_override(self, cell_id: str, src: CellSourceOverride) -> None:
        import pandas as pd

        path = Path(src.csv_path)
        if not path.exists():
            print(f"[DatasetLoader] {cell_id}: override file not found: {src.csv_path}")
            self._use_synthetic(cell_id)
            return

        try:
            df: "pd.DataFrame" = pd.read_csv(path, low_memory=False)
            df.columns = pd.Index([c.strip() for c in df.columns])

            if src.id_column.upper() != "ALL":
                try:
                    df = df[df[src.id_column] == int(src.id_value)]
                except (ValueError, KeyError):
                    df = df[df[src.id_column].astype(str) == src.id_value]

            if df.empty:
                self._use_synthetic(cell_id)
                return

            values = (
                pd.to_numeric(df[src.value_column], errors="coerce")
                .fillna(0)
                .to_numpy(dtype=float)
            )
            self._load_factors[cell_id] = self._normalise(values)
            self._source_info[cell_id]  = f"override ({src.csv_path}, {src.value_column})"

        except Exception as e:
            print(f"[DatasetLoader] {cell_id}: override error: {e}")
            self._use_synthetic(cell_id)

    # ── Synthetic fallback ───────────────────────────────────────────

    def _use_synthetic(self, cell_id: str) -> None:
        self._load_factors[cell_id] = self._synthetic_diurnal(cell_id)
        self._source_info[cell_id]  = "synthetic"

    def _synthetic_diurnal(self, cell_id: str) -> List[float]:
        row       = int(cell_id[1]) if len(cell_id) > 1 else 0
        peak_hour = 19 + row
        base_load = 0.25 + row * 0.05
        intervals: List[float] = []
        for day in range(7):
            for interval in range(144):
                hour    = interval / 6.0
                morning = 0.15 * math.exp(-0.5 * ((hour - 9)         / 1.5) ** 2)
                evening = 0.50 * math.exp(-0.5 * ((hour - peak_hour) / 2.0) ** 2)
                weekend = 0.85 if day >= 5 else 1.0
                load    = min(0.95, max(0.05, base_load + morning + evening) * weekend)
                noise   = self.rng.gauss(0, 0.02)
                intervals.append(float(np.clip(load + noise, 0.05, 0.95)))
        return intervals

    # ── Helpers ──────────────────────────────────────────────────────

    def _pick_value_column(self, df: "pd.DataFrame") -> Optional[str]:
        preferred = ["internet", "smsin", "smsout", "callin", "callout"]
        for col in preferred:
            if col in df.columns:
                return col
        for col in df.columns:
            if df[col].dtype in ["float64", "int64"] and "id" not in col.lower():
                return col
        print("[DatasetLoader] No usable value column found")
        return None

    def _normalise(self, values: "np.ndarray") -> List[float]:
        mn, mx = float(values.min()), float(values.max())
        if mx == mn:
            return [0.3] * len(values)
        return (0.05 + 0.90 * (values - mn) / (mx - mn)).tolist()

    # ── Tick expansion ────────────────────────────────────────────────

    def _expand_to_ticks(self) -> None:
        for cell_id, intervals in self._load_factors.items():
            ticks: List[float] = []
            for base in intervals:
                for _ in range(TICKS_PER_INTERVAL):
                    noise = self.rng.gauss(0, 0.015)
                    ticks.append(float(np.clip(base + noise, 0.02, 0.98)))
            self._tick_cache[cell_id] = ticks

    # ── Summary ───────────────────────────────────────────────────────

    def _print_summary(self) -> None:
        real  = sum(1 for v in self._source_info.values() if not v.startswith("synthetic"))
        synth = len(ALL_CELL_IDS) - real
        print(f"[DatasetLoader] Ready: {real} real / {synth} synthetic cells")
        for cell_id in ALL_CELL_IDS:
            print(f"  {cell_id} -> {self._source_info.get(cell_id, 'synthetic')}")

    # ── Public API ────────────────────────────────────────────────────

    def get_load_factor(self, cell_id: str, tick: int) -> float:
        ticks = self._tick_cache.get(cell_id)
        if not ticks:
            return 0.3
        return ticks[tick % len(ticks)]

    def is_peak_hour(self, tick: int) -> bool:
        ticks_per_day  = 144 * TICKS_PER_INTERVAL
        tick_in_day    = tick % ticks_per_day
        ticks_per_hour = 6  * TICKS_PER_INTERVAL
        hour = tick_in_day / ticks_per_hour
        return 8.0 <= hour < 22.0

    def list_sources(self) -> List[dict]:
        return [
            {
                "cell_id": cid,
                "source":  self._source_info.get(cid, "synthetic"),
                "ticks":   len(self._tick_cache.get(cid, [])),
            }
            for cid in ALL_CELL_IDS
        ]