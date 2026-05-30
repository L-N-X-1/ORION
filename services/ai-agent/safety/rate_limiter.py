"""Rate limiter helpers — query PostgreSQL for recent change count."""
import os
import asyncpg

DATABASE_URL = os.getenv("POSTGRES_URL")

async def recent_change_count(minutes: int = 10) -> int:
	conn = await asyncpg.connect(DATABASE_URL)
	try:
		rows = await conn.fetch("SELECT COUNT(*) FROM audit_log WHERE executed_at > now() - ($1 * interval '1 minute')", minutes)
		return rows[0][0] if rows else 0
	finally:
		await conn.close()
