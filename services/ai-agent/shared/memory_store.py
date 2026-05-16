"""
shared/memory_store.py
----------------------
A lightweight in-process KPI and incident store.

In production this would be backed by Redis or a database.  For the MVP
it lives in a module-level dict so all agents running in the same process
share the same state without extra infrastructure.

Keys
----
kpi:{entity_id}          → list[KPISnapshot]  (latest 100 snapshots per cell)
incident:{incident_id}   → IncidentRecord
"""

from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from typing import Any, Dict, List, Optional

from shared.schemas import IncidentRecord, KPISnapshot

# ── storage ──────────────────────────────────────────────────────────────────
_kpi_store: Dict[str, deque] = defaultdict(lambda: deque(maxlen=100))
_incident_store: Dict[str, IncidentRecord] = {}
_lock = asyncio.Lock()


# ── KPI helpers ───────────────────────────────────────────────────────────────

async def store_kpi(snapshot: KPISnapshot) -> None:
    async with _lock:
        _kpi_store[snapshot.entity_id].append(snapshot)


async def get_recent_kpis(entity_id: str, n: int = 10) -> List[KPISnapshot]:
    async with _lock:
        return list(_kpi_store[entity_id])[-n:]


async def get_latest_kpi(entity_id: str) -> Optional[KPISnapshot]:
    async with _lock:
        buf = _kpi_store[entity_id]
        return buf[-1] if buf else None


# ── Incident helpers ──────────────────────────────────────────────────────────

async def store_incident(record: IncidentRecord) -> None:
    async with _lock:
        _incident_store[record.incident_id] = record


async def get_incident(incident_id: str) -> Optional[IncidentRecord]:
    async with _lock:
        return _incident_store.get(incident_id)


async def find_incident_by_correlation(correlation_id: str) -> Optional[IncidentRecord]:
    """Return the first open incident that shares correlation_id."""
    async with _lock:
        for record in _incident_store.values():
            if record.correlation_id == correlation_id:
                return record
    return None


async def all_incidents() -> List[IncidentRecord]:
    async with _lock:
        return list(_incident_store.values())