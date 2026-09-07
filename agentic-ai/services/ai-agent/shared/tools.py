"""
shared/tools.py
---------------
HTTP tool wrappers used by multiple agents.

Each function maps to one REST endpoint exposed by the collector or
digital-twin service.  The base URLs are resolved from environment
variables so they work both locally (docker-compose service names) and
in CI (localhost with port-forwarding).

Environment variables (see .env.example):
    COLLECTOR_URL   – e.g. http://collector:8001
    TWIN_URL        – e.g. http://digital-twin:8000
    TICKET_URL      – e.g. http://api-gateway:8080
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

import httpx

log = logging.getLogger(__name__)

COLLECTOR_URL = os.getenv("COLLECTOR_URL", "http://collector:8001")
TWIN_URL = os.getenv("TWIN_URL", "http://digital-twin:8000")
TICKET_URL = os.getenv("TICKET_URL", "http://api-gateway:8080")

# Shared async client — reused across calls inside the same process.
_client: Optional[httpx.AsyncClient] = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=10.0)
    return _client


# ─────────────────────────────────────────────
# query_metrics
# ─────────────────────────────────────────────

# shared/tools.py — update these three functions

async def query_metrics(
    kpi: str,
    entity_id: str,
    time_range_minutes: int = 10,
) -> List[Dict[str, Any]]:
    client = _get_client()
    try:
        resp = await client.get(
            f"{TWIN_URL}/metrics",          # call twin directly, not collector
            params={
                "cell_id": entity_id,       # twin uses cell_id, not entity_id
                "last_n": time_range_minutes * 2,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("kpis", [])
    except Exception as exc:
        log.warning("query_metrics failed for %s/%s: %s", entity_id, kpi, exc)
        return []


async def query_all_kpis(
    entity_id: str,
    time_range_minutes: int = 10,
) -> Dict[str, Any]:
    client = _get_client()
    try:
        resp = await client.get(
            f"{TWIN_URL}/metrics",
            params={"cell_id": entity_id, "last_n": 1},
        )
        resp.raise_for_status()
        data = resp.json()
        kpis = data.get("kpis", [])
        return kpis[-1] if kpis else {}
    except Exception as exc:
        log.warning("query_all_kpis failed for %s: %s", entity_id, exc)
        return {}


async def get_topology(entity_id: str) -> Dict[str, Any]:
    client = _get_client()
    try:
        resp = await client.get(
            f"{TWIN_URL}/topology",
            params={"entity_id": entity_id},   # query param, not path param
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        log.warning("get_topology failed for %s: %s", entity_id, exc)
        return {}

# ─────────────────────────────────────────────
# get_full_topology  (all cells)
# ─────────────────────────────────────────────

async def get_full_topology() -> Dict[str, Any]:
    """Return the full 12-cell topology graph from the digital twin."""
    client = _get_client()
    try:
        resp = await client.get(f"{TWIN_URL}/topology")
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        log.warning("get_full_topology failed: %s", exc)
        return {}


# ─────────────────────────────────────────────
# create_ticket
# ─────────────────────────────────────────────

async def create_ticket(
    summary: str,
    severity: str,
    incident_id: str,
    extra: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    """
    Open a service-management ticket via the API gateway.
    Returns the ticket_id string or None on failure.
    """
    client = _get_client()
    payload = {
        "summary": summary,
        "severity": severity,
        "incident_id": incident_id,
        "extra": extra or {},
    }
    try:
        resp = await client.post(f"{TICKET_URL}/tickets", json=payload)
        resp.raise_for_status()
        return resp.json().get("ticket_id")
    except Exception as exc:
        log.warning("create_ticket failed: %s", exc)
        return None