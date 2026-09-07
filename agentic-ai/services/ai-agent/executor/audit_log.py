"""Audit log writer — append-only entries to PostgreSQL audit_log table."""

from __future__ import annotations

import os
import asyncpg

DATABASE_URL = os.getenv("POSTGRES_URL")


async def write_audit(change_id: str, incident_id: str, action_type: str, parameters_hash: str, policy_decision: str, actor: str, pre_ref: str | None = None):
	conn = await asyncpg.connect(DATABASE_URL)
	try:
		await conn.execute(
			"""
			INSERT INTO audit_log(change_id, incident_id, action_type, parameters_hash, policy_decision, actor, pre_change_kpi_ref)
			VALUES($1,$2,$3,$4,$5,$6,$7)
			""",
			change_id, incident_id, action_type, parameters_hash, policy_decision, actor, pre_ref,
		)
	finally:
		await conn.close()
