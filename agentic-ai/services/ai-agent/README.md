# AI Agent Service — ORION

**Port:** `8004` &nbsp;|&nbsp; **Base URL:** `http://localhost:8004`

Autonomous closed-loop network operations service. Receives 5G network events (via Kafka or HTTP), runs a multi-agent LangGraph pipeline to detect, diagnose, plan, and remediate incidents, and optionally requests human approval before executing changes.

---

## Architecture Overview

```
External Events
      │
      ├── Kafka (aura.event.v1)
      └── POST /run (HTTP direct)
           │
           ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                    LangGraph Pipeline                       │
  │                                                             │
  │  START                                                      │
  │    │                                                        │
  │    ▼                                                        │
  │  [TRIAGE]  ──(halted)──────────────────────────────► END   │
  │    │                                                        │
  │    ▼                                                        │
  │  [ROOT CAUSE]  ──(halted)──────────────────────────► END   │
  │    │                                                        │
  │    ▼                                                        │
  │  [PLANNER]                                                  │
  │    │                                                        │
  │    ▼                                                        │
  │  [SAFETY]  ──(DENY / halted)───────────────────────► END   │
  │    │                   │                                    │
  │    │ (ALLOW)           │ (ALLOW_WITH_APPROVAL)              │
  │    │                   ▼                                    │
  │    │          [HUMAN APPROVAL]  ──(rejected)────────► END   │
  │    │                   │ (approved)                         │
  │    └───────────────────┘                                    │
  │                        │                                    │
  │                        ▼                                    │
  │                  [EXECUTOR]                                 │
  │                        │                                    │
  │                        ▼                                    │
  │                  [VERIFIER]  ──(regression → rollback)      │
  │                        │                                    │
  │                       END                                   │
  └─────────────────────────────────────────────────────────────┘
```

A parallel **Anomaly Detection Loop** runs every 30 s in the background. It scans KPI history for all 12 cells using an LLM + deterministic fallback, and fires early-warning `CONGESTION` events before thresholds are breached.

---

## Pipeline State

Each pipeline run threads a single `PipelineState` dict through all nodes. Every agent reads upstream outputs and writes its own:

| State field | Written by | Contains |
|---|---|---|
| `raw_event` | Caller | `NetworkEvent` — trigger |
| `incident_record` | Triage | `IncidentRecord` — type, severity, scope, evidence |
| `rca_report` | Root Cause | `RCAReport` — hypotheses, dominant root cause |
| `action_plan` | Planner | `ActionPlan` — selected action + what-if forecast |
| `policy_decision` | Safety | `PolicyDecisionRecord` — ALLOW / ALLOW_WITH_APPROVAL / DENY |
| `change_confirmation` | Executor | `ChangeConfirmation` — change ID, pre-change KPI ref |
| `verification_report` | Verifier | `VerificationReport` — outcome, KPI delta, postmortem |

`pipeline_halted = True` at any node short-circuits the rest of the graph.

---

## Agents

### 1. Triage Agent (`triage/`)

**Role:** Detect  
**Input:** `raw_event`  
**Output:** `incident_record`

Steps:
1. **Deduplication** — skip if same `correlation_id` already has an open incident.
2. **Storm suppression** — halt if an active incident already covers this entity + type within the last 5 min; claim in-flight lock to prevent race with concurrent Kafka events.
3. **Classify** — map `event_type` → `IncidentType` (CONGESTION / OUTAGE / MOBILITY_STORM / BACKHAUL_DEGRADATION / MISCONFIGURATION). Falls back to KPI-based classification when event type is UNKNOWN.
4. **Evidence window** — fetch last N KPI ticks from memory store; compute pre-incident baseline.
5. **Severity** — rule-based: LOW / MEDIUM / HIGH / CRITICAL based on KPI thresholds and incident type.
6. **Scope expansion** — pull cell neighbours + backhaul peers to widen affected entity list.
7. **LLM summary** — Ollama generates ≤120-word operator-readable incident description. Falls back to template on LLM failure.
8. **Ticket** — opens a NOC ticket automatically for CRITICAL severity incidents.
9. **Persist** — writes `IncidentRecord` to Redis memory store.

### 2. Root Cause Agent (`root_cause/`)

**Role:** Analyze  
**Input:** `incident_record`  
**Output:** `rca_report`

Steps:
1. **KPI history** — fetch last 15 ticks per affected entity; fall back to triage evidence bundle.
2. **Pattern detection** — identifies congestion cells, backhaul cells, mobility storm cells, SINR-degraded cells, SLA violation cells across the scope.
3. **Correlation matrix** — computes KPI cross-correlations between entities.
4. **Topology traversal** — finds neighbours, backhaul peers, and synchronised degradation cells.
5. **Hypothesis tree** — builds ranked hypotheses (e.g. `traffic_burst_slice_too_narrow`, `backhaul_capacity_reduction`, `bad_handover_parameters`). Each hypothesis carries a confidence score and a recommended remediation lever.
6. **LLM confidence adjustment** — Ollama reviews hypothesis list against KPI snapshot and adjusts scores. Falls back to deterministic ranking on failure.
7. **LLM RCA summary** — generates ≤200-word technical narrative for NOC operators.
8. **Remediation levers** — deduplicated list of levers ordered by hypothesis confidence (feeds directly into Planner).

### 3. Planner Agent (`planner/`)

**Role:** Plan  
**Input:** `rca_report`  
**Output:** `action_plan`

Steps:
1. **Action catalogue lookup** — maps dominant lever (e.g. `apply_slice_policy`) to 1–3 concrete candidate actions with parameters.
2. **What-if simulation** — runs each candidate through the digital-twin what-if engine; gets predicted KPI deltas over a 120-tick horizon.
3. **Delta forecast scoring** — scores each simulation for PRB improvement and SLA clearance confidence.
4. **LLM action selection** — Ollama picks the optimal candidate given time-of-day, risk scores, and KPI improvement. Deterministic fallback: highest aggregate KPI improvement.
5. **Approval flag** — sets `approval_required = True` when blast radius > 10 cells, during peak hours (08–22 UTC), or when what-if confidence < 60%.

### 4. Safety Agent (`safety/`)

**Role:** Guard  
**Input:** `action_plan` + `incident_record`  
**Output:** `policy_decision`

Two-tier evaluation:
- **Tier 1 (always):** Deterministic policy engine evaluates rules — blast radius limits, change rate limits, action type allow-lists, peak-hour restrictions, reversibility requirements. Returns ALLOW / ALLOW_WITH_APPROVAL / DENY.
- **Tier 2 (only on ALLOW):** LLM secondary review checks for context the rules can't catch — wrong target entity, KPI evidence contradicting the chosen action, underestimated blast radius. Escalates to ALLOW_WITH_APPROVAL only if confidence ≥ 0.7.

### 5. Human Approval Node (`orchestrator/human_approval.py`)

**Triggered:** Safety returns `ALLOW_WITH_APPROVAL`

1. Serialises approval request to Redis (`approval:{incident_id}`) with 30-min TTL.
2. Logs operator-facing warning with the `/approvals/{incident_id}/decision` URL.
3. Calls `interrupt()` — LangGraph checkpoints state and **suspends the pipeline thread**.
4. Pipeline resumes when operator POSTs a decision:
   - `approved` → policy decision flipped to ALLOW → Executor runs.
   - `rejected` → `pipeline_halted = True` → pipeline ends.

### 6. Executor Agent (`executor/`)

**Role:** Act  
**Input:** `action_plan` + `policy_decision`  
**Output:** `change_confirmation`

Steps:
1. **Idempotency check** — if a `ChangeConfirmation` already exists for this incident, return it without re-executing.
2. **Actuator call** — POST action payload to `actuator:8003`. Receives `change_id` and pre-change KPI snapshot.
3. **Audit log** — writes SHA-256 payload hash + approver source to audit trail.
4. Emits `ChangeConfirmation` with pre-change KPI reference for the Verifier.

### 7. Verifier Agent (`verifier/`)

**Role:** Verify + Close loop  
**Input:** `change_confirmation` + `incident_record`  
**Output:** `verification_report`

Steps:
1. **Pre-change snapshot** — fetches KPI snapshot from actuator by `change_id`.
2. **Post-change polling** — polls KPIs from the digital twin every `TICK_INTERVAL_S` seconds for N ticks (action-type dependent: `tune_handover` = 10 ticks, others = 5).
3. **SLA clearance check** — outcome is `success` if all post-change ticks have no SLA violations; otherwise `regression`.
4. **Auto-rollback** — on regression, triggers rollback via actuator immediately.
5. **LLM postmortem** — Ollama generates full post-incident report covering: incident summary, root cause, action taken, KPI before/after delta, outcome, lessons learned.

---

## Data Flow Summary

```
NetworkEvent
    │
    └─ Triage ──► IncidentRecord
                      │
                      └─ Root Cause ──► RCAReport (HypothesisTree, levers)
                                            │
                                            └─ Planner ──► ActionPlan (selected action, what-if)
                                                               │
                                                               └─ Safety ──► PolicyDecisionRecord
                                                                                  │
                                                                    ┌─────────────┤
                                                                    │             │
                                                               [ALLOW]   [ALLOW_WITH_APPROVAL]
                                                                    │             │
                                                                    │      Human Approval
                                                                    │             │
                                                                    └──────┬──────┘
                                                                           │
                                                                    Executor ──► ChangeConfirmation
                                                                           │
                                                                    Verifier ──► VerificationReport
                                                                                  (+ auto-rollback)
```

---

## LLM Usage

All agents use **Ollama** (`llama3.2` / `llama3.3` by default, configurable via `OLLAMA_MODEL` env var). Every LLM call is non-blocking and has a deterministic fallback — the pipeline completes even if Ollama is unreachable.

| Agent | LLM task | Fallback |
|---|---|---|
| Anomaly Detector | Early-warning trend detection | Deterministic PRB rising-trend rule |
| Triage | Incident summary (≤120 words) | Template string |
| Root Cause | Hypothesis confidence adjustment | Original deterministic ranking |
| Root Cause | RCA narrative (≤200 words) | Template string |
| Planner | Best action selection | Highest aggregate KPI improvement |
| Safety | Secondary contextual review | Keep ALLOW (rules are authoritative) |
| Verifier | Full post-incident postmortem | Not generated |

---

## HTTP API Reference

### `POST /run` — Trigger pipeline manually

```powershell
Invoke-RestMethod -Method POST -Uri http://localhost:8004/run `
  -ContentType "application/json" `
  -Body '{
    "event_id": "evt-001",
    "correlation_id": "corr-001",
    "event_type": "CONGESTION",
    "entity_id": "C00",
    "severity_hint": "high",
    "sim_time_s": 200.0,
    "timestamp": "2026-05-16T20:00:00Z"
  }'
```

Returns `200` with full pipeline state, or `202 awaiting_approval` when the pipeline suspends at human approval.

---

### `POST /approvals/{incident_id}/decision` — Approve or reject a suspended pipeline

```powershell
# Find pending approval keys in Redis
docker exec orion-redis-1 redis-cli KEYS "approval:*"

# Approve (replace INC-XXXXXX with actual incident ID from the 202 response)
Invoke-WebRequest -Uri http://localhost:8004/approvals/INC-C23FCF47/decision `
  -Method POST -ContentType "application/json" `
  -Body '{"decision":"approved","approver":"ops@orion.test"}' | Select-Object -Expand Content
```

- `"decision": "approved"` → pipeline resumes at Executor.
- `"decision": "rejected"` → pipeline halts.
- Approval key expires after **30 minutes**. After expiry, re-trigger the event.

---

### `POST /seed-kpi` — Seed a KPI snapshot (dev / testing)

Injects a snapshot directly into the Redis memory store without needing the digital twin running.

```powershell
Invoke-RestMethod -Method POST -Uri http://localhost:8004/seed-kpi `
  -ContentType "application/json" `
  -Body '{
    "entity_id": "C00",
    "timestamp": "2026-05-16T20:00:00Z",
    "prb_utilization": 97.5,
    "throughput_mbps": 12.0,
    "sinr_db": 4.0,
    "cqi": 5,
    "latency_p95_ms": 85.0,
    "packet_loss_pct": 3.2,
    "cpu_load_pct": 88.0,
    "ho_fail_rate": 0.04,
    "energy_mode": "ACTIVE",
    "sla_violation": true,
    "is_peak": true
  }'
```

---

### `GET /memory` — Inspect KPI memory store (dev)

```powershell
Invoke-RestMethod -Uri "http://localhost:8004/memory?entity_id=C00&n=5"
```

---

### `GET /health`

```powershell
Invoke-RestMethod -Uri http://localhost:8004/health
# {"status": "ok"}
```

---

## End-to-End Test Walkthrough

```powershell
# 1. Inject a congestion scenario via the simulation engine
Invoke-WebRequest -Uri http://localhost:8001/fault/inject-agent `
  -Method POST -ContentType "application/json" `
  -Body '{"scenario":"evening_congestion"}' | Select-Object -Expand Content

# 2. Watch the pipeline run in logs
docker compose logs ai-agent -f

# 3. Check affected cell KPIs
Invoke-WebRequest -Uri http://localhost:8001/metrics | `
  ConvertFrom-Json | Select-Object -Expand kpis | `
  Where-Object { $_.cell_id -in "C00","C01","C10" } | `
  Select-Object cell_id, prb_util, sla_violation

# 4. If pipeline suspended for approval, find the incident ID
docker exec orion-redis-1 redis-cli KEYS "approval:*"

# 5. Approve the pending action
Invoke-WebRequest -Uri http://localhost:8004/approvals/INC-C23FCF47/decision `
  -Method POST -ContentType "application/json" `
  -Body '{"decision":"approved","approver":"ops@orion.test"}' | Select-Object -Expand Content
```

---

## Configuration

| Env var | Default | Description |
|---|---|---|
| `OLLAMA_MODEL` | `llama3.2` | Ollama model name |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama endpoint |
| `AGENT_PORT` | `8003` | FastAPI listen port (override in docker-compose) |
| `ANOMALY_INTERVAL_S` | `30` | Seconds between anomaly detection sweeps |
| `TICK_INTERVAL_S` | `5` | Seconds between post-change KPI polls in Verifier |
| `ACTUATOR_URL` | `http://actuator:8003` | Actuator service base URL |
| `LOG_LEVEL` | `INFO` | Python logging level |

---

## Source Layout

```
services/ai-agent/
├── orchestrator/
│   ├── graph.py              # LangGraph StateGraph definition
│   ├── langgraph_runner.py   # FastAPI app + Kafka consumer + anomaly loop
│   └── human_approval.py     # Human-in-the-loop interrupt node
├── triage/
│   ├── agent.py              # Triage LangGraph node
│   ├── classifier.py         # Rule-based event → IncidentType mapping
│   ├── evidence.py           # KPI evidence window + scope expansion
│   └── incident_record.py    # IncidentRecord factory helpers
├── root_cause/
│   ├── agent.py              # RCA LangGraph node
│   ├── correlator.py         # KPI correlation matrix + pattern detection
│   ├── hypothesis_tree.py    # Hypothesis builder with confidence scores
│   └── topology_graph.py     # Neighbour / backhaul peer / sync degradation
├── planner/
│   ├── agent.py              # Planner LangGraph node
│   ├── action_catalogue.py   # Lever → candidate action mapping
│   ├── whatif_engine.py      # What-if simulation via digital twin
│   └── delta_forecast.py     # Forecast scoring
├── safety/
│   ├── agent.py              # Safety LangGraph node
│   ├── policy_engine.py      # Deterministic policy rules
│   ├── blast_radius.py       # Blast radius calculator
│   └── rate_limiter.py       # Change rate limit tracker
├── executor/
│   ├── agent.py              # Executor LangGraph node
│   ├── action_runner.py      # Actuator HTTP client
│   ├── idempotency.py        # Idempotency key store
│   └── audit_log.py          # Audit trail writer
├── verifier/
│   ├── agent.py              # Verifier LangGraph node
│   ├── kpi_monitor.py        # Post-change KPI poller
│   ├── rollback_trigger.py   # Auto-rollback on regression
│   └── postmortem.py         # LLM postmortem generator
└── shared/
    ├── schemas.py             # Pydantic models (PipelineState + all artifacts)
    ├── memory_store.py        # Redis-backed KPI + incident store
    ├── event_bus.py           # Kafka consumer + KPI poller
    ├── redis_client.py        # Redis connection helpers
    └── tools.py               # Shared tool calls (topology, ticket creation)
```
