"""Verifier LangGraph node — compares pre/post KPIs, triggers rollback if needed,
then generates a full LLM post-incident report."""

from __future__ import annotations

import logging
import os
from typing import Any, Dict

import httpx

from shared.schemas import PipelineState, VerificationReport
from verifier.kpi_monitor import poll_post_change_kpis
from verifier.postmortem import generate_postmortem
from verifier.rollback_trigger import trigger_rollback

log = logging.getLogger(__name__)

ACT_URL = os.environ.get("ACTUATOR_URL", "http://actuator:8003")


async def verifier_node(state: Dict[str, Any]) -> Dict[str, Any]:
    pipeline = PipelineState(**state)

    if pipeline.change_confirmation is None or pipeline.incident_record is None:
        pipeline.pipeline_halted = True
        pipeline.halt_reason = "Missing inputs for verifier"
        return pipeline.model_dump()

    cc       = pipeline.change_confirmation
    incident = pipeline.incident_record

    # ── Fetch pre-change KPI snapshot from actuator ───────────────────────────
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(f"{ACT_URL}/changes/{cc.change_id}/snapshot")
        resp.raise_for_status()
        pre_raw = resp.json()

    # ── Poll post-change KPIs ─────────────────────────────────────────────────
    tick_map = {"apply_slice_policy": 3, "tune_handover": 10}
    ticks    = tick_map.get(cc.action_type, 5)
    interval = int(os.environ.get("TICK_INTERVAL_S", "5"))
    target   = (
        cc.parameters_applied.get("cell_id")
        or (incident.affected_entities[0] if incident.affected_entities else None)
        or "C00"
    )
    samples = await poll_post_change_kpis(cc.change_id, target, ticks, interval)

    # ── Determine outcome ─────────────────────────────────────────────────────
    sla_cleared    = all(not v.get("sla_violation", False) for v in samples)
    outcome        = "success" if sla_cleared else "regression"
    rollback_triggered = False
    if not sla_cleared:
        await trigger_rollback(cc.change_id, cc.incident_id)
        rollback_triggered = True

    # ── Build KPI before/after dicts for report ───────────────────────────────
    # pre_raw is a list of cell snapshots; use the target cell
    pre_snap  = next((s for s in pre_raw if s.get("cell_id") == target), pre_raw[0] if pre_raw else {})
    post_snap = samples[-1] if samples else {}

    _kpi_keys = ("prb_util", "latency_p95_ms", "throughput_mbps", "sla_violation", "ho_fail_rate")
    kpi_before = {k: pre_snap.get(k)  for k in _kpi_keys if k in pre_snap}
    kpi_after  = {k: post_snap.get(k) for k in _kpi_keys if k in post_snap}

    # ── Collect full pipeline context for postmortem ──────────────────────────
    incident_dict = (
        incident.model_dump(mode="json") if hasattr(incident, "model_dump") else incident
    )
    rca_dict = None
    if pipeline.rca_report is not None:
        rca_dict = (
            pipeline.rca_report.model_dump(mode="json")
            if hasattr(pipeline.rca_report, "model_dump")
            else pipeline.rca_report
        )
    action_plan_dict = None
    if pipeline.action_plan is not None:
        action_plan_dict = (
            pipeline.action_plan.model_dump(mode="json")
            if hasattr(pipeline.action_plan, "model_dump")
            else pipeline.action_plan
        )
    cc_dict = cc.model_dump(mode="json") if hasattr(cc, "model_dump") else cc

    # ── Generate LLM post-incident report ─────────────────────────────────────
    postmortem = await generate_postmortem(
        incident=incident_dict,
        rca=rca_dict,
        action_plan=action_plan_dict,
        change_confirmation=cc_dict,
        kpi_before=kpi_before,
        kpi_after=kpi_after,
        outcome=outcome,
        rollback_triggered=rollback_triggered,
    )

    log.info(
        "Verifier: incident=%s outcome=%s rollback=%s\n%s",
        incident.incident_id, outcome, rollback_triggered,
        "─" * 60 + "\n" + postmortem + "\n" + "─" * 60,
    )

    report = VerificationReport(
        change_id=cc.change_id,
        incident_id=incident.incident_id,
        outcome=outcome,
        kpi_before=kpi_before,
        kpi_after=kpi_after,
        rollback_triggered=rollback_triggered,
        final_sla_state=sla_cleared,
        postmortem=postmortem,
    )
    pipeline.verification_report = report
    return pipeline.model_dump()
