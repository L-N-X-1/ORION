"""
root_cause/topology_graph.py
----------------------------
Graph-based dependency traversal for the Root Cause Agent.

Answers questions like:
  - "Which cells share this backhaul link?"
  - "Which neighbours show synchronised KPI degradation?"
  - "Is the congestion isolated or propagating across the grid?"
"""

from __future__ import annotations

import logging
from typing import Dict, List, Optional

from shared.schemas import KPISnapshot
from shared.tools import get_topology

log = logging.getLogger(__name__)

# KPI divergence threshold: two cells are "synchronised" if their latest
# PRB utilisation is within SYNC_BAND percent of each other.
SYNC_BAND_PCT = 20.0


async def get_neighbours(entity_id: str) -> List[str]:
    """Return the list of direct-neighbour cell IDs for entity_id."""
    topo = await get_topology(entity_id)
    return topo.get("neighbours", [])


async def get_backhaul_peers(entity_id: str) -> List[str]:
    """Return cells that share the same backhaul link as entity_id."""
    topo = await get_topology(entity_id)
    return topo.get("backhaul_peers", [])


async def find_synchronised_degradation(
    root_entity: str,
    kpis_by_entity: Dict[str, List[KPISnapshot]],
    kpi_field: str = "prb_utilization",
) -> List[str]:
    """
    Return a list of entity IDs whose latest value for kpi_field is within
    SYNC_BAND_PCT of root_entity's value — indicating correlated degradation.

    This is the key check that separates a single-cell anomaly from a
    multi-cell systemic issue.
    """
    root_snaps = kpis_by_entity.get(root_entity, [])
    if not root_snaps:
        return []

    root_val = getattr(root_snaps[-1], kpi_field, None)
    if root_val is None:
        return []

    synchronised: List[str] = []
    for eid, snaps in kpis_by_entity.items():
        if eid == root_entity or not snaps:
            continue
        val = getattr(snaps[-1], kpi_field, None)
        if val is not None and abs(val - root_val) <= SYNC_BAND_PCT:
            synchronised.append(eid)

    return synchronised


async def compute_structural_impact(
    affected_entities: List[str],
) -> Dict[str, object]:
    """
    For each entity, fetch its topology and compute:
      - total_neighbours   : int
      - backhaul_peer_count: int
      - is_hub             : bool  (degree > 3)

    Returns a dict keyed by entity_id.
    """
    result: Dict[str, object] = {}
    for eid in affected_entities:
        topo = await get_topology(eid)
        if not topo:
            result[eid] = {}
            continue
        neighbours = topo.get("neighbours", [])
        backhaul_peers = topo.get("backhaul_peers", [])
        result[eid] = {
            "total_neighbours": len(neighbours),
            "backhaul_peer_count": len(backhaul_peers),
            "is_hub": len(neighbours) >= 4,
        }
    return result