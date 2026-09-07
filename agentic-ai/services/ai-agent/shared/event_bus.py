"""
shared/event_bus.py
-------------------
Kafka consumer that subscribes to aura.event.v1 and aura.kpi.v1 and
dispatches messages to registered async callbacks.

Also runs a background REST poller against the digital-twin's /metrics
endpoint as a fallback, since the digital-twin does not publish KPIs to
Kafka directly — it only writes to InfluxDB.

Usage (inside the FastAPI lifespan or a background task):

    from shared.event_bus import EventBus, poll_kpis_from_twin

    bus = EventBus()
    bus.on_event(my_event_handler)          # async def handler(event: NetworkEvent)
    asyncio.create_task(bus.start())        # Kafka consumer
    asyncio.create_task(poll_kpis_from_twin())  # REST poller fallback
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime
from typing import Awaitable, Callable, List

import httpx
from aiokafka import AIOKafkaConsumer

from shared.memory_store import store_kpi
from shared.schemas import KPISnapshot, NetworkEvent

log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

KAFKA_BROKERS    = os.getenv("KAFKA_BROKERS", "kafka:9092")
EVENT_TOPIC      = "aura.event.v1"
KPI_TOPIC        = "aura.kpi.v1"
CONSUMER_GROUP   = "ai-agent-group"
TWIN_URL         = os.getenv("TWIN_URL", "http://digital-twin:8001")
POLL_INTERVAL_S  = int(os.getenv("TICK_INTERVAL_S", "5"))

EventHandler = Callable[[NetworkEvent], Awaitable[None]]


# ── KPI REST poller (fallback — digital-twin doesn't publish to Kafka) ────────

async def poll_kpis_from_twin() -> None:
    """
    Polls GET /metrics from the digital-twin every POLL_INTERVAL_S seconds
    and stores each cell's latest KPI snapshot in the in-memory store.

    This is the primary KPI ingestion path because the current digital-twin
    implementation writes to InfluxDB only — it has no Kafka publisher.
    The Kafka consumer below handles KPI messages if they ever appear, but
    this poller ensures the memory store is always populated regardless.
    """
    log.info("KPI poller started — polling %s/metrics every %ds", TWIN_URL, POLL_INTERVAL_S)
    async with httpx.AsyncClient(timeout=5.0) as client:
        while True:
            try:
                resp = await client.get(f"{TWIN_URL}/metrics")
                if resp.status_code == 200:
                    data = resp.json()
                    kpis: list = data.get("kpis", [])
                    stored = 0
                    for k in kpis:
                        try:
                            snap = KPISnapshot(
                                entity_id=k["cell_id"],
                                timestamp=datetime.utcnow(),
                                prb_utilization=float(k.get("prb_util", 0.0)),
                                throughput_mbps=float(k.get("throughput_mbps", 0.0)),
                                sinr_db=float(k.get("sinr_db", 0.0)),
                                cqi=int(k.get("cqi", 0)),
                                latency_p95_ms=float(k.get("latency_p95_ms", 0.0)),
                                packet_loss_pct=float(k.get("packet_loss_pct", 0.0)),
                                cpu_load_pct=float(k.get("cpu_load_pct", 0.0)),
                                ho_fail_rate=float(k.get("ho_fail_rate", 0.0)),
                                energy_mode=k.get("energy_mode", "ACTIVE"),
                                sla_violation=bool(k.get("sla_violation", False)),
                                is_peak=bool(k.get("is_peak", False)),
                            )
                            await store_kpi(snap)
                            stored += 1
                        except Exception as exc:
                            log.warning("KPI snapshot parse error: %s — raw: %s", exc, k)
                    if stored:
                        log.debug("KPI poller stored %d snapshots from digital-twin", stored)
                else:
                    log.warning("KPI poller got HTTP %d from digital-twin", resp.status_code)
            except Exception as exc:
                log.warning("KPI poller request failed: %s", exc)

            await asyncio.sleep(POLL_INTERVAL_S)


# ── Kafka consumer ────────────────────────────────────────────────────────────

class EventBus:
    def __init__(self) -> None:
        self._event_handlers: List[EventHandler] = []
        self._running = False

    def on_event(self, handler: EventHandler) -> None:
        """Register an async callback that receives every NetworkEvent."""
        self._event_handlers.append(handler)

    async def start(self) -> None:
        """
        Start consuming both topics in a single consumer group.
        Runs until cancelled.
        """
        self._running = True
        consumer = AIOKafkaConsumer(
            EVENT_TOPIC,
            KPI_TOPIC,
            bootstrap_servers=KAFKA_BROKERS,
            group_id=CONSUMER_GROUP,
            auto_offset_reset="latest",
            value_deserializer=lambda v: json.loads(v.decode("utf-8")),
        )
        await consumer.start()
        log.info("EventBus subscribed to %s, %s", EVENT_TOPIC, KPI_TOPIC)
        try:
            async for msg in consumer:
                if not self._running:
                    break
                await self._dispatch(msg.topic, msg.value)
        finally:
            await consumer.stop()

    async def stop(self) -> None:
        self._running = False

    async def _dispatch(self, topic: str, payload: dict) -> None:
        if topic == KPI_TOPIC:
            await self._handle_kpi(payload)
        elif topic == EVENT_TOPIC:
            await self._handle_event(payload)

    async def _handle_kpi(self, payload: dict) -> None:
        """Handle KPI messages arriving via Kafka (if twin ever publishes them)."""
        try:
            snapshot = KPISnapshot(**payload)
            await store_kpi(snapshot)
        except Exception as exc:
            log.warning("Bad KPI payload: %s — %s", exc, payload)

    async def _handle_event(self, payload: dict) -> None:
        try:
            if "timestamp" not in payload:
                payload["timestamp"] = datetime.utcnow().isoformat()
            event = NetworkEvent(**payload)
        except Exception as exc:
            log.warning("Bad event payload: %s — %s", exc, payload)
            return

        for handler in self._event_handlers:
            try:
                await handler(event)
            except Exception as exc:
                log.error("Event handler %s raised: %s", handler.__name__, exc)