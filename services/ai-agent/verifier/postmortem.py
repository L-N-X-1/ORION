"""LLM-driven post-incident report generator."""

from __future__ import annotations

import os
from langchain_core.messages import SystemMessage, HumanMessage
from langchain_ollama import ChatOllama

_llm = ChatOllama(model=os.getenv("OLLAMA_MODEL", "llama3.2"), temperature=0, base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"))


SYSTEM = """You are the Verifier Agent writing a concise post-incident report."""


async def generate_postmortem(incident_id: str, timeline: str, before: dict, after: dict, actions: list) -> str:
	prompt = (
		f"Incident {incident_id}\nTimeline:\n{timeline}\nBefore:\n{before}\nAfter:\n{after}\nActions:\n{actions}\nWrite a concise post-incident report with lessons learned."
	)
	resp = await _llm.ainvoke([SystemMessage(content=SYSTEM), HumanMessage(content=prompt)])
	return resp.content.strip()
