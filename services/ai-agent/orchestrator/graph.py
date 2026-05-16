"""
orchestrator/graph.py
---------------------
LangGraph StateGraph definition for the AURA-NET agent pipeline.

Current wired nodes (Milestone 2):
    triage       → NOC Triage Agent
    root_cause   → Root Cause Agent

Stub nodes (wired but no-op until their milestone):
    planner      → Planner Agent        (Milestone 3)
    safety       → Safety/Policy Agent  (Milestone 4)
    executor     → Executor Agent       (Milestone 4)
    verifier     → Verifier Agent       (Milestone 4-5)

Graph flow:
    START → triage → root_cause → planner → safety → executor → verifier → END

Conditional edges are used to short-circuit the pipeline when:
  - triage or root_cause sets pipeline_halted = True
  - safety returns DENY

State schema
------------
The pipeline state is a plain Python dict whose keys correspond to
PipelineState fields.  LangGraph requires the state type to be either a
TypedDict or an annotated dict.  We use PipelineState.model_fields to
drive the TypedDict at runtime.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Literal

from langgraph.graph import END, START, StateGraph

from root_cause.agent import root_cause_node
from triage.agent import triage_node

log = logging.getLogger(__name__)

# ── Stub nodes for future milestones ─────────────────────────────────────────


async def planner_node(state: Dict[str, Any]) -> Dict[str, Any]:
    """Milestone 3 — Planner Agent (stub)."""
    log.info("Planner node: stub — passing state through")
    return state


async def safety_node(state: Dict[str, Any]) -> Dict[str, Any]:
    """Milestone 4 — Safety/Policy Agent (stub)."""
    log.info("Safety node: stub — passing state through")
    return state


async def executor_node(state: Dict[str, Any]) -> Dict[str, Any]:
    """Milestone 4 — Executor Agent (stub)."""
    log.info("Executor node: stub — passing state through")
    return state


async def verifier_node(state: Dict[str, Any]) -> Dict[str, Any]:
    """Milestone 4-5 — Verifier Agent (stub)."""
    log.info("Verifier node: stub — passing state through")
    return state


# ── Conditional routing helpers ───────────────────────────────────────────────


def _should_continue_after_triage(
    state: Dict[str, Any],
) -> Literal["root_cause", "__end__"]:
    """Route to root_cause unless the pipeline was halted by the Triage Agent."""
    if state.get("pipeline_halted"):
        log.warning("Pipeline halted after triage: %s", state.get("halt_reason"))
        return END
    return "root_cause"


def _should_continue_after_rca(
    state: Dict[str, Any],
) -> Literal["planner", "__end__"]:
    """Route to planner unless the pipeline was halted by the Root Cause Agent."""
    if state.get("pipeline_halted"):
        log.warning("Pipeline halted after RCA: %s", state.get("halt_reason"))
        return END
    return "planner"


def _should_continue_after_safety(
    state: Dict[str, Any],
) -> Literal["executor", "__end__"]:
    """
    Route to executor only if the safety decision is ALLOW.
    ALLOW_WITH_APPROVAL and DENY both short-circuit to END
    (the Safety Agent has already logged the decision and notified operators).
    """
    decision_record = state.get("policy_decision")
    if decision_record is None or state.get("pipeline_halted"):
        return END
    decision = (
        decision_record.get("decision")
        if isinstance(decision_record, dict)
        else getattr(decision_record, "decision", None)
    )
    if decision == "allow":
        return "executor"
    log.info("Safety gate blocked execution: decision=%s", decision)
    return END


# ── Graph construction ────────────────────────────────────────────────────────


def build_graph() -> StateGraph:
    """
    Construct and compile the AURA-NET LangGraph pipeline.

    Returns a compiled graph ready to be invoked with:
        await graph.ainvoke({"raw_event": event.model_dump()})
    """
    # LangGraph requires the state to be a plain dict; we use Any typing here
    # because PipelineState fields are optional and evolve through the pipeline.
    graph = StateGraph(dict)

    # ── Add nodes ─────────────────────────────────────────────────────────────
    graph.add_node("triage", triage_node)
    graph.add_node("root_cause", root_cause_node)
    graph.add_node("planner", planner_node)
    graph.add_node("safety", safety_node)
    graph.add_node("executor", executor_node)
    graph.add_node("verifier", verifier_node)

    # ── Edges ─────────────────────────────────────────────────────────────────
    graph.add_edge(START, "triage")

    graph.add_conditional_edges(
        "triage",
        _should_continue_after_triage,
        {"root_cause": "root_cause", END: END},
    )

    graph.add_conditional_edges(
        "root_cause",
        _should_continue_after_rca,
        {"planner": "planner", END: END},
    )

    # Planner → Safety (no condition: planner always passes to safety)
    graph.add_edge("planner", "safety")

    graph.add_conditional_edges(
        "safety",
        _should_continue_after_safety,
        {"executor": "executor", END: END},
    )

    # Executor → Verifier → END
    graph.add_edge("executor", "verifier")
    graph.add_edge("verifier", END)

    return graph.compile()


# Module-level compiled graph — import this in langgraph_runner.py
pipeline = build_graph()