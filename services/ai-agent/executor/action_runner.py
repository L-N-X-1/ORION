"""Call actuator service endpoints to apply actions."""

from __future__ import annotations

import os
import httpx
from typing import Dict, Any

ACTUATOR_URL = os.getenv("ACTUATOR_URL", "http://actuator:8003")


async def call_actuator(action: Dict[str, Any]) -> Dict[str, Any]:
	async with httpx.AsyncClient(timeout=10.0) as client:
		atype = action.get("action_type")
		if atype == "apply_slice_policy":
			resp = await client.post(f"{ACTUATOR_URL}/actions/apply_slice_policy", json=action)
		elif atype == "tune_handover":
			resp = await client.post(f"{ACTUATOR_URL}/actions/tune_handover", json=action)
		elif atype == "enable_energy_saving":
			resp = await client.post(f"{ACTUATOR_URL}/actions/enable_energy_saving", json=action)
		elif atype == "rollback":
			resp = await client.post(f"{ACTUATOR_URL}/actions/rollback", json={"change_id": action.get("change_id")})
		else:
			raise ValueError(f"Unknown action_type: {atype}")
		resp.raise_for_status()
		return resp.json()
