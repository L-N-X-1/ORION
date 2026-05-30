"""KPI monitor: poll digital-twin /metrics and query InfluxDB for post-change comparison."""

from __future__ import annotations

import os
import asyncio
import time
from typing import Dict, Any, List

import httpx
from influxdb_client import InfluxDBClient

INFLUX_URL = os.getenv("INFLUXDB_URL")
INFLUX_TOKEN = os.getenv("INFLUXDB_TOKEN")
INFLUX_ORG = os.getenv("INFLUXDB_ORG")
INFLUX_BUCKET = os.getenv("INFLUXDB_BUCKET")
TWIN_URL = os.getenv("TWIN_URL", "http://digital-twin:8001")


async def poll_post_change_kpis(change_id: str, target_entity: str, ticks: int, interval_s: int):
	client = httpx.AsyncClient(timeout=10.0)
	influx = InfluxDBClient(url=INFLUX_URL, token=INFLUX_TOKEN, org=INFLUX_ORG)
	query_api = influx.query_api()
	results: List[Dict[str, Any]] = []
	try:
		for _ in range(ticks):
			# call twin for latest metrics
			resp = await client.get(f"{TWIN_URL}/metrics", params={"cell_id": target_entity, "last_n": 1})
			resp.raise_for_status()
			data = resp.json().get("kpis", [])
			if data:
				results.append(data[-1])
			await asyncio.sleep(interval_s)
		return results
	finally:
		await client.aclose()
		influx.close()
