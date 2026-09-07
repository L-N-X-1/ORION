"""AURA-NET — planner/whatif_engine | Ticket: AN-AGT-003

Async wrapper around digital-twin POST /whatif/run
"""

from __future__ import annotations

import os
from typing import Any, Dict

import httpx

TWIN_URL = os.getenv("TWIN_URL", "http://digital-twin:8001")


async def run_whatif(action_plan: Dict[str, Any], horizon_ticks: int = 120) -> Dict[str, Any]:
	async with httpx.AsyncClient(timeout=20.0) as client:
		resp = await client.post(f"{TWIN_URL}/whatif/run", json={"action_plan": action_plan, "horizon_ticks": horizon_ticks})
		resp.raise_for_status()
		return resp.json()
