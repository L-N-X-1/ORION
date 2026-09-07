"""Redis-based idempotency guard for executor."""

from __future__ import annotations

from typing import Optional
import os
import json
from shared.redis_client import get_value, set_value

KEY_FMT = "executor:idempotency:{incident_id}"


async def get_existing_change(incident_id: str) -> Optional[dict]:
	v = await get_value(KEY_FMT.format(incident_id=incident_id))
	if not v:
		return None
	return json.loads(v)


async def store_change(incident_id: str, change_record: dict, ttl_seconds: int = 3600) -> None:
	await set_value(KEY_FMT.format(incident_id=incident_id), json.dumps(change_record), ttl_seconds)
