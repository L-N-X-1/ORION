# AURA-NET 🛰️

> An autonomous AI-powered Network Operations Center (NOC) for 5G/6G infrastructure — built on a digital twin simulation engine and a multi-agent AI pipeline.

## What it does

- **Digital Twin** — SimPy-based 5G RAN simulator generating realistic KPIs (PRB, SINR, latency, throughput) driven by real Milan traffic data
- **Multi-Agent AI** — Six specialized agents (Triage → Root Cause → Planner → Safety → Executor → Verifier) running a closed-loop `Detect → Decide → Act → Verify` cycle
- **Autonomous NOC** — Detects incidents, diagnoses root causes, proposes and executes remediations, and rolls back if things get worse

## Architecture

```
Digital Twin → Kafka → [Triage → RCA → Planner → Safety → Executor → Verifier]
                                                              ↓
                                                         Actuator → Twin
```

## Milestones

- [ ] **M1** — Digital Twin + Telemetry (Sprint 1)
- [ ] **M2** — Triage & Root Cause Agents (Sprint 2)
- [ ] **M3** — Planner + First Closed Loop (Sprint 3)
- [ ] **M4** — Safety Guardrails + Full Autonomy (Sprint 4)
- [ ] **M5** — 6G Extensions + Reinforcement Learning

## Quick start

```bash
git clone https://github.com/YOUR_USERNAME/aura-net.git
cd aura-net
make up
```

Services will be available at:
| Service | URL |
|---|---|
| API Gateway | http://localhost:8000 |
| Grafana | http://localhost:3001 |
| Digital Twin | http://localhost:8001 |
| InfluxDB | http://localhost:8086 |

## Tech stack

`Python` `SimPy` `FastAPI` `LangGraph` `Anthropic Claude` `Kafka` `InfluxDB` `PostgreSQL` `Redis` `Grafana` `Docker`

## Progress

Follow along on [LinkedIn](#) as I build this milestone by milestone.

---
Built as a home lab project exploring 5G network automation and agentic AI.
