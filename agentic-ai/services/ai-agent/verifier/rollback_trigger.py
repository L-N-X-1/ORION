"""Trigger rollback via Actuator service when regression detected."""

from __future__ import annotations

import os
import httpx

ACTUATOR_URL = os.getenv("ACTUATOR_URL", "http://actuator:8003")


async def trigger_rollback(change_id: str, incident_id: str = "") -> dict:
	async with httpx.AsyncClient(timeout=10.0) as client:
		resp = await client.post(
			f"{ACTUATOR_URL}/actions/rollback",
			json={"change_id": change_id, "incident_id": incident_id or change_id},
		)
		resp.raise_for_status()
		return resp.json()
