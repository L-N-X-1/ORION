# Actuator Service — ORION

**Port:** `8003` &nbsp;|&nbsp; **Base URL:** `http://localhost:8003`

Broker between the AI Agent pipeline and the Digital Twin. Receives approved action commands from the Executor node, takes a pre-change KPI snapshot, applies the configuration change to the Digital Twin, persists the change record to PostgreSQL, and serves snapshots back to the Verifier node for post-change comparison.

---

## Role in the Pipeline

The Actuator is called at two points in the closed-loop pipeline:

```
AI Agent Pipeline
      │
      │  ① Executor node → POST /actions/<action_type>
      │     ┌──────────────────────────────────────────────┐
      │     │              ACTUATOR                        │
      │     │                                              │
      │     │  1. Snapshot pre-change KPIs (Digital Twin)  │
      │     │  2. Forward action → Digital Twin            │
      │     │  3. Store change_record (PostgreSQL)         │
      │     │  4. Return change_id + pre_change_kpis       │
      │     └──────────────────────────────────────────────┘
      │
      │  ② Verifier node → GET /changes/{change_id}/snapshot
      │     Returns stored pre-change KPIs for before/after comparison
      │
      │  ③ Verifier node (on regression) → POST /actions/rollback
      │     Actuator forwards rollback to Digital Twin + marks record rolled_back
      │
      ▼
   END (VerificationReport)
```

**Upstream callers:**
- `executor/agent.py` — calls `/actions/*` to apply approved changes
- `verifier/agent.py` — calls `/changes/{id}/snapshot` and `/actions/rollback`

**Downstream target:**
- Digital Twin at `http://digital-twin:8001` — single source of simulated network state

---

## What It Does Per Action

### `POST /actions/apply_slice_policy`

1. Fetches pre-change KPI snapshot from Digital Twin `/metrics` (all cells, last 3 ticks).
2. Forwards `slice_id`, `min_bw_pct`, `max_bw_pct`, `priority` to Digital Twin.
3. Digital Twin mutates `WorldState.slices` in-memory; clears any active `evening_congestion` synthetic fault.
4. Stores `change_record` to PostgreSQL with `action_type = "apply_slice_policy"`.
5. Returns `change_id` + `pre_change_kpis`.

**Use case:** Remediate CONGESTION / MISCONFIGURATION incidents by relaxing or reprioritising slice bandwidth allocations.

---

### `POST /actions/tune_handover`

1. Fetches pre-change KPI snapshot for the target `cell_id`.
2. Forwards `cell_id`, `a3_offset`, `ttt_ms` to Digital Twin.
3. Digital Twin mutates `CellState.a3_offset` / `CellState.ttt_ms` in-memory.
4. Stores change record. Returns `change_id` + `pre_change_kpis`.

**Use case:** Remediate MOBILITY_STORM incidents — reducing `a3_offset` or increasing `ttt_ms` stabilises handover decisions.

---

### `POST /actions/enable_energy_saving`

1. Fetches pre-change KPI snapshot for the target `cell_id`.
2. Forwards `cell_id`, `mode` (`ACTIVE` / `SLEEP` / `SHUTDOWN`) to Digital Twin.
3. Digital Twin sets `CellState.energy_mode`.
4. Stores change record. Returns `change_id` + `pre_change_kpis`.

**Use case:** Put lightly-loaded cells into `SLEEP` mode during off-peak periods, or restore `ACTIVE` mode when demand rises.

---

### `POST /actions/rollback`

1. Looks up the original change record in PostgreSQL by `change_id`.
2. Extracts `_twin_change_id` from stored parameters.
3. Forwards rollback request to Digital Twin `/actions/rollback`.
4. Digital Twin reverts the in-memory state (energy mode → `ACTIVE`, handover → defaults `a3_offset=3.0 / ttt_ms=40.0`, slice → original parameters).
5. Updates PostgreSQL `change_records.status = 'rolled_back'`.

---

## Data Flow Detail

```
Executor Agent
    │
    │  POST /actions/apply_slice_policy
    │  {incident_id, slice_id, min_bw_pct, max_bw_pct, priority}
    │
    ▼
Actuator
    │
    ├──► GET digital-twin:8001/metrics  ─── pre-change KPI snapshot
    │
    ├──► POST digital-twin:8001/actions/apply_slice_policy
    │         ◄── {change_id: "CHG-XXXXXX", applied: {...}}
    │
    ├──► INSERT change_records (PostgreSQL)
    │      change_id, incident_id, action_type, parameters (JSONB),
    │      pre_change_kpis (JSONB), status="applied", sim_time_s
    │
    └──► return {change_id, pre_change_kpis}  ──► Executor Agent

...later...

Verifier Agent
    │
    ├──► GET /changes/{change_id}/snapshot  ◄── pre_change_kpis from PostgreSQL
    │
    └── (on regression) POST /actions/rollback
              └──► Digital Twin + UPDATE change_records status="rolled_back"
```

---

## PostgreSQL Schema

Two tables written by the Actuator:

### `change_records`

| Column | Type | Description |
|---|---|---|
| `change_id` | `VARCHAR(20) PK` | `CHG-{8 hex chars}` — unique per action |
| `incident_id` | `VARCHAR(20)` | Incident that triggered the change |
| `action_type` | `VARCHAR(50)` | `apply_slice_policy` / `tune_handover` / `enable_energy_saving` |
| `parameters` | `JSONB` | Full action params + `_twin_change_id` reference |
| `pre_change_kpis` | `JSONB` | KPI snapshot taken before the action |
| `status` | `VARCHAR(20)` | `applied` / `rolled_back` |
| `sim_time_s` | `FLOAT` | Digital Twin simulation time at execution |
| `created_at` | `TIMESTAMPTZ` | Record creation time |

### `audit_log`

| Column | Type | Description |
|---|---|---|
| `change_id` | `VARCHAR(50)` | Links to change_records |
| `incident_id` | `VARCHAR(50)` | Owning incident |
| `action_type` | `VARCHAR(50)` | Action performed |
| `parameters_hash` | `TEXT` | SHA-256 of action payload (written by Executor agent) |
| `policy_decision` | `VARCHAR(30)` | `allow` / `allow_with_approval` |
| `actor` | `VARCHAR(50)` | `ai-executor` or approver identity |
| `pre_change_kpi_ref` | `TEXT` | Reference to pre-change snapshot |
| `executed_at` | `TIMESTAMPTZ` | Execution timestamp |

> Note: `audit_log` rows are written by the **Executor agent** (`executor/audit_log.py`), not by the Actuator itself.

---

## HTTP API Reference

### `GET /health`

```powershell
Invoke-RestMethod -Uri http://localhost:8003/health
# {"status": "ok", "service": "actuator"}
```

---

### `POST /actions/apply_slice_policy`

```powershell
# Minimal — let Digital Twin keep existing min_bw
Invoke-RestMethod -Method POST -Uri http://localhost:8003/actions/apply_slice_policy `
  -ContentType "application/json" `
  -Body '{
    "incident_id": "INC-test-001",
    "slice_id": "slice-premium",
    "max_bw_pct": 80.0
  }'

# Full parameters
Invoke-RestMethod -Method POST -Uri http://localhost:8003/actions/apply_slice_policy `
  -ContentType "application/json" `
  -Body '{
    "incident_id": "INC-test-001",
    "slice_id": "slice-premium",
    "min_bw_pct": 30.0,
    "max_bw_pct": 80.0,
    "priority": 1
  }'
```

Response: `{"change_id": "CHG-XXXXXXXX", "pre_change_kpis": [...]}`

---

### `POST /actions/tune_handover`

```powershell
Invoke-RestMethod -Method POST -Uri http://localhost:8003/actions/tune_handover `
  -ContentType "application/json" `
  -Body '{
    "incident_id": "INC-test-002",
    "cell_id": "C00",
    "a3_offset": 2.0,
    "ttt_ms": 80.0
  }'
```

Response: `{"change_id": "CHG-XXXXXXXX", "pre_change_kpis": [...]}`

---

### `POST /actions/enable_energy_saving`

```powershell
Invoke-RestMethod -Method POST -Uri http://localhost:8003/actions/enable_energy_saving `
  -ContentType "application/json" `
  -Body '{"incident_id": "INC-test-003", "cell_id": "C00", "mode": "SLEEP"}'
```

Valid modes: `ACTIVE`, `SLEEP`, `SHUTDOWN`

---

### `POST /actions/rollback`

```powershell
Invoke-RestMethod -Method POST -Uri http://localhost:8003/actions/rollback `
  -ContentType "application/json" `
  -Body '{"incident_id": "INC-test-001", "change_id": "CHG-42AE6070"}'
```

Response: `{"rolled_back": "CHG-42AE6070"}`

---

### `GET /changes/{change_id}`

Retrieve full change record from PostgreSQL.

```powershell
$change_id = "CHG-42AE6070"
Invoke-RestMethod -Method GET -Uri http://localhost:8003/changes/$change_id
```

Response includes: `change_id`, `incident_id`, `action_type`, `parameters`, `pre_change_kpis`, `status`, `sim_time_s`, `created_at`.

---

### `GET /changes/{change_id}/snapshot`

Returns only the `pre_change_kpis` JSON array — used by the Verifier agent for before/after KPI comparison.

```powershell
Invoke-RestMethod -Method GET -Uri http://localhost:8003/changes/$change_id/snapshot
```

---

## Change ID Format

```
CHG-{8 hex chars uppercase}
```

Examples from recent runs:
```
CHG-B380837B
CHG-0849BB88
CHG-A7B4C474
CHG-42AE6070
```

The `_twin_change_id` field stored inside `parameters` is a separate ID issued by the Digital Twin (6 hex chars). The Actuator uses this when forwarding rollback requests to the Digital Twin.

---

## Service Integration Map

```
                    ┌──────────────────┐
                    │   AI Agent       │
                    │   (port 8004)    │
                    │                  │
                    │  Executor node ──┼──► POST /actions/*
                    │  Verifier node ──┼──► GET  /changes/*/snapshot
                    │  Verifier node ──┼──► POST /actions/rollback
                    └──────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │    ACTUATOR      │
                    │   (port 8003)    │
                    │                  │
                    │  PostgreSQL ─────┼── change_records, audit_log
                    └──────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  Digital Twin    │
                    │   (port 8001)    │
                    │                  │
                    │  WorldState      │
                    │  (in-memory)     │
                    └──────────────────┘
```

---

## Source Layout

```
services/actuator/
├── main.py            # All FastAPI routes + action handlers + DB logic
├── change_record.py   # (stub — TODO AN-ACT-001)
├── slice_policy.py    # (stub — TODO AN-ACT-001)
├── handover_tuner.py  # (stub — TODO AN-ACT-001)
├── energy_mode.py     # (stub — TODO AN-ACT-001)
└── rollback.py        # (stub — TODO AN-ACT-001)
```

All active logic lives in `main.py`. The module stubs are placeholders for the planned refactor under ticket AN-ACT-001.

---

## Configuration

| Env var | Default | Description |
|---|---|---|
| `POSTGRES_URL` | — | PostgreSQL connection string (required) |
| `TWIN_URL` | `http://digital-twin:8001` | Digital Twin base URL |
