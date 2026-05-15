"""
AURA-NET Digital Twin — event_generator.py
Ticket: AN-TWN-001

Checks KPI thresholds after each tick and emits structured events
onto the aura.event.v1 Kafka topic (and an in-memory queue for REST).
"""
from __future__ import annotations

import json
import uuid
import asyncio
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Deque, Dict, List

if TYPE_CHECKING:
    from world_state import WorldState

# Thresholds
CONGESTION_PRB_THRESHOLD    = 95.0   # %
CONGESTION_TICKS_REQUIRED   = 3      # consecutive ticks above threshold
SIGNAL_SINR_THRESHOLD       = 0.0    # dB
HO_FAIL_RATE_THRESHOLD      = 0.10   # 10%
BACKHAUL_DELAY_THRESHOLD    = 80.0   # ms
BACKHAUL_LOSS_THRESHOLD     = 3.0    # %

# Max events kept in the in-memory ring buffer
EVENT_BUFFER_SIZE = 500


class EventGenerator:

    def __init__(self, kafka_producer=None) -> None:
        self._kafka = kafka_producer
        # ring buffer for REST polling
        self._event_buffer: Deque[dict] = deque(maxlen=EVENT_BUFFER_SIZE)
        # track consecutive congestion ticks per cell
        self._congestion_streak: Dict[str, int] = defaultdict(int)

    # ── Main entry point ────────────────────────────────────────────

    def evaluate(self, kpis: List[dict], state: "WorldState") -> List[dict]:
        """
        Called after every KPI tick.
        Returns list of events emitted this tick.
        """
        events = []
        for kpi in kpis:
            events += self._check_congestion(kpi, state)
            events += self._check_signal(kpi)
            events += self._check_mobility(kpi)
            events += self._check_backhaul(kpi, state)
            events += self._check_outage(kpi)

        for ev in events:
            self._emit(ev)

        return events

    # ── Threshold checks ────────────────────────────────────────────

    def _check_congestion(self, kpi: dict, state) -> List[dict]:
        cid = kpi["cell_id"]
        if kpi["prb_util"] >= CONGESTION_PRB_THRESHOLD:
            self._congestion_streak[cid] += 1
        else:
            self._congestion_streak[cid] = 0

        if self._congestion_streak[cid] == CONGESTION_TICKS_REQUIRED:
            return [self._make_event(
                event_type="CONGESTION",
                entity_id=cid,
                severity=self._congestion_severity(kpi),
                evidence={
                    "prb_util":        kpi["prb_util"],
                    "throughput_mbps": kpi["throughput_mbps"],
                    "latency_p95_ms":  kpi["latency_p95_ms"],
                    "sla_violation":   kpi["sla_violation"],
                    "consecutive_ticks": CONGESTION_TICKS_REQUIRED,
                },
                sim_time_s=kpi["sim_time_s"],
            )]
        return []

    def _check_signal(self, kpi: dict) -> List[dict]:
        if kpi["sinr_db"] < SIGNAL_SINR_THRESHOLD:
            return [self._make_event(
                event_type="SIGNAL_DEGRADATION",
                entity_id=kpi["cell_id"],
                severity="HIGH" if kpi["sinr_db"] < -5 else "MEDIUM",
                evidence={
                    "sinr_db": kpi["sinr_db"],
                    "cqi":     kpi["cqi"],
                },
                sim_time_s=kpi["sim_time_s"],
            )]
        return []

    def _check_mobility(self, kpi: dict) -> List[dict]:
        if kpi["ho_fail_rate"] > HO_FAIL_RATE_THRESHOLD:
            return [self._make_event(
                event_type="HO_FAILURE",
                entity_id=kpi["cell_id"],
                severity="HIGH" if kpi["ho_fail_rate"] > 0.25 else "MEDIUM",
                evidence={
                    "ho_fail_rate": kpi["ho_fail_rate"],
                    "prb_util":     kpi["prb_util"],
                },
                sim_time_s=kpi["sim_time_s"],
            )]
        return []

    def _check_backhaul(self, kpi: dict, state) -> List[dict]:
        bh = state.backhaul.get(kpi["cell_id"])
        if bh and (bh.delay_ms > BACKHAUL_DELAY_THRESHOLD
                   or bh.loss_pct > BACKHAUL_LOSS_THRESHOLD):
            return [self._make_event(
                event_type="BACKHAUL_DEGRADATION",
                entity_id=kpi["cell_id"],
                severity="CRITICAL" if bh.delay_ms > 150 else "HIGH",
                evidence={
                    "backhaul_delay_ms": bh.delay_ms,
                    "backhaul_loss_pct": bh.loss_pct,
                    "latency_p95_ms":    kpi["latency_p95_ms"],
                },
                sim_time_s=kpi["sim_time_s"],
            )]
        return []

    def _check_outage(self, kpi: dict) -> List[dict]:
        from world_state import EnergyMode
        # OUTAGE = SHUTDOWN mode detected
        if kpi["energy_mode"] == EnergyMode.SHUTDOWN.value:
            return [self._make_event(
                event_type="OUTAGE",
                entity_id=kpi["cell_id"],
                severity="CRITICAL",
                evidence={"energy_mode": kpi["energy_mode"]},
                sim_time_s=kpi["sim_time_s"],
            )]
        return []

    # ── Helpers ─────────────────────────────────────────────────────

    def _congestion_severity(self, kpi: dict) -> str:
        if kpi["sla_violation"] and kpi["prb_util"] > 99:
            return "CRITICAL"
        elif kpi["sla_violation"]:
            return "HIGH"
        return "MEDIUM"

    def _make_event(self, event_type: str, entity_id: str,
                    severity: str, evidence: dict,
                    sim_time_s: float) -> dict:
        return {
            "event_id":    str(uuid.uuid4()),
            "correlation_id": f"{entity_id}-{event_type}",
            "event_type":  event_type,
            "entity_id":   entity_id,
            "severity":    severity,
            "ts":          datetime.now(timezone.utc).isoformat(),
            "sim_time_s":  sim_time_s,
            "evidence":    evidence,
        }

    def _emit(self, event: dict) -> None:
        self._event_buffer.append(event)
        if self._kafka:
            try:
                self._kafka.send(
                    "aura.event.v1",
                    value=json.dumps(event).encode()
                )
            except Exception as e:
                print(f"[EventGenerator] Kafka send error: {e}")

    # ── REST access ─────────────────────────────────────────────────

    def get_recent_events(self, limit: int = 50) -> List[dict]:
        events = list(self._event_buffer)
        return events[-limit:]

    def get_events_for_entity(self, entity_id: str, limit: int = 20) -> List[dict]:
        return [e for e in self._event_buffer
                if e["entity_id"] == entity_id][-limit:]
