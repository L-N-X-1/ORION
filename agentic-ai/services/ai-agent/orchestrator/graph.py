"""
orchestrator/graph.py
---------------------
LangGraph StateGraph definition for the AURA-NET agent pipeline.

Graph flow:
    START → triage → root_cause → planner → safety ──(ALLOW)──────────────→ executor → verifier → END
                                                    └─(ALLOW_WITH_APPROVAL)→ human_approval ──(approved)→ executor → verifier → END
                                                    └─(DENY / halted)──────→ END
                                                                           └─(rejected)────────────────→ END

Conditional edges short-circuit when:
  - triage or root_cause sets pipeline_halted = True
  - safety returns DENY
  - safety returns ALLOW_WITH_APPROVAL and operator rejects
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Literal

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from orchestrator.human_approval import human_approval_node
from planner.agent import planner_node
from root_cause.agent import root_cause_node
from triage.agent import triage_node

log = logging.getLogger(__name__)

# ── Stub nodes for future milestones ─────────────────────────────────────────


from safety.agent import safety_node
from executor.agent import executor_node
from verifier.agent import verifier_node


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
) -> Literal["executor", "human_approval", "__end__"]:
    """
    Route based on safety decision:
      ALLOW              → executor (fully automated)
      ALLOW_WITH_APPROVAL → human_approval (operator must confirm)
      DENY / halted      → END
    """
    decision_record = state.get("policy_decision")
    if decision_record is None or state.get("pipeline_halted"):
        return END
    decision = (
        decision_record.get("decision")
        if isinstance(decision_record, dict)
        else getattr(decision_record, "decision", None)
    )
    log.info("safety_router: decision=%r halted=%s", decision, state.get("pipeline_halted"))
    if decision == "allow":
        return "executor"
    if decision == "allow_with_approval":
        return "human_approval"
    log.info("Safety gate blocked execution: decision=%s", decision)
    return END


def _should_continue_after_human_approval(
    state: Dict[str, Any],
) -> Literal["executor", "__end__"]:
    """Route to executor if operator approved, else END."""
    if state.get("pipeline_halted"):
        log.warning("Pipeline halted after human approval: %s", state.get("halt_reason"))
        return END
    return "executor"


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
    graph.add_node("human_approval", human_approval_node)
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

    graph.add_edge("planner", "safety")

    graph.add_conditional_edges(
        "safety",
        _should_continue_after_safety,
        {"executor": "executor", "human_approval": "human_approval", END: END},
    )

    graph.add_conditional_edges(
        "human_approval",
        _should_continue_after_human_approval,
        {"executor": "executor", END: END},
    )

    # Executor → Verifier → END
    graph.add_edge("executor", "verifier")
    graph.add_edge("verifier", END)

    return graph.compile(checkpointer=MemorySaver())


# Module-level compiled graph — import this in langgraph_runner.py
pipeline = build_graph()