"""
triage/evidence.py
------------------
Builds the evidence bundle that the Triage Agent attaches to an
IncidentRecord.

Responsibilities
----------------
1. Pull a sliding KPI window for the primary entity.
2. Expand scope to neighbours via the topology graph.
3. Return a list of KPISnapshot objects (the evidence bundle) plus a
   separate pre-incident baseline list.
"""

from __future__ import annotations

import logging
from typing import List, Tuple

from shared.memory_store import get_recent_kpis
from shared.schemas import KPISnapshot
from shared.tools import get_topology, query_metrics

log = logging.getLogger(__name__)

# How many ticks to include in the evidence window
EVIDENCE_WINDOW_TICKS = 10
# How many ticks to use for the pre-incident baseline (before the window)
BASELINE_TICKS = 5


async def build_evidence_window(
    entity_id: str,
    time_range_minutes: int = 10,
) -> Tuple[List[KPISnapshot], List[KPISnapshot]]:
    """
    Returns (evidence_kpis, pre_incident_baseline).

    evidence_kpis       — the EVIDENCE_WINDOW_TICKS most recent snapshots
                          for entity_id from the in-memory store.
    pre_incident_baseline — the BASELINE_TICKS snapshots just before the
                            evidence window.
    """
    recent = await get_recent_kpis(entity_id, n=EVIDENCE_WINDOW_TICKS + BASELINE_TICKS)
    if not recent:
        log.warning("No in-memory KPIs for %s; falling back to HTTP", entity_id)
        raw = await query_metrics("prb_utilization", entity_id, time_range_minutes)
        # raw is a list of {timestamp, value} dicts from the collector
        # We cannot build full KPISnapshot objects from a single KPI series,
        # so we return empty and let the agent proceed with partial evidence.
        return [], []

    baseline = recent[:BASELINE_TICKS]
    evidence = recent[BASELINE_TICKS:]
    return evidence, baseline


async def expand_scope(entity_id: str) -> List[str]:
    """
    Query the topology graph and return a list of entity IDs that should
    be included in the incident scope (neighbours + same-backhaul cells).
    """
    topo = await get_topology(entity_id)
    if not topo:
        return []

    neighbours: List[str] = topo.get("neighbours", [])
    # Include cells that share the same backhaul link (same link_id)
    backhaul_cells: List[str] = topo.get("backhaul_peers", [])

    scope = list({entity_id, *neighbours, *backhaul_cells})
    return scope