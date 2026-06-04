# ORION Digital Twin

FastAPI service that runs a simulated 5G RAN and exposes REST endpoints for agents, collectors, and observability tools.

**Port:** `8001`  
**Tick interval:** 5 s (configurable via `TICK_INTERVAL_S`)

---

## Architecture

```
DatasetLoader ──► SimPy tick loop ──► KpiSynthesizer ──► InfluxDB
                        │                                     │
                   MobilityProcess                         Kafka (aura.kpi.v1)
                        │
                  WorldState (cells, slices, UEs, backhaul)
                        │
                  EventGenerator ──► Kafka (aura.events.v1)
```

**Topology:** 3×4 grid of gNodeB cells (`C00`–`C23`), each with:
- 100 PRBs, 1 Gbps max throughput
- 10 UEs (split across `slice-premium`, `slice-standard`, `slice-iot`)
- Backhaul link (default 5 ms delay, 0.1% loss)
- 4-connected neighbours

**Slices:**

| Slice | Priority | Min BW | Max BW | SLA Latency |
|---|---|---|---|---|
| `slice-premium` | 1 (highest) | 20% | 80% | 20 ms |
| `slice-standard` | 5 | 10% | 70% | 50 ms |
| `slice-iot` | 9 (lowest) | 5% | 40% | 200 ms |

---

## KPIs

Ten KPIs are synthesized per cell per tick by `KpiSynthesizer.synthesize()`.

### KPI Reference

| KPI | Unit | Range | Description |
|---|---|---|---|
| `prb_util` | % | 0–100 | Physical Resource Block utilization |
| `throughput_mbps` | Mbps | 0–1000 | Effective cell throughput |
| `sinr_db` | dB | −∞–20+ | Signal-to-interference-noise ratio |
| `cqi` | index | 0–15 | Channel Quality Indicator (3GPP-aligned) |
| `latency_p95_ms` | ms | 5+ | 95th-percentile latency |
| `packet_loss_pct` | % | 0–20 | Packet loss percentage |
| `cpu_load_pct` | % | 0–100 | gNodeB baseband CPU load |
| `ho_fail_rate` | ratio | 0–1 | Handover failure rate (failures / attempts) |
| `energy_mode` | string | ACTIVE/SLEEP/SHUTDOWN | Cell power state |
| `sla_violation` | bool | — | True when any SLA threshold breached |

### How KPIs Are Generated

Each tick, `KpiSynthesizer._compute_cell_kpi()` runs the following formulas:

**PRB Utilization**
```
prb_util = (current_load × max_prb) / effective_prb × 100
```
`effective_prb` = 100% in ACTIVE, 30% in SLEEP, 0% in SHUTDOWN. Small Gaussian noise (σ=0.5%) added each tick.

**Throughput**
```
raw_tp = (prb_util / 100) × max_throughput_mbps
degradation = 1 − 0.6 × ((prb_util − 80) / 20)²  [if prb_util > 80, else 1.0]
throughput = raw_tp × degradation + gauss(0, raw_tp × 0.02)
```
Non-linear collapse above 80% PRB models head-of-line blocking.

**SINR**
```
own_penalty    = 10 × (prb_util / 100)^1.5
interference   = 8 × avg_neighbour_load
mode_penalty   = 6.0 dB  [SLEEP only]
sinr_db = 20 − own_penalty − interference − mode_penalty + gauss(0, 0.3)
```

**CQI**  
Lookup table mapping SINR → CQI index (3GPP TS 38.214 aligned, thresholds −6 dB to +25 dB).

**Latency p95**
```
queuing     = 30 × ((prb_util − 70) / 30)²  [if prb_util > 70, else 0]
latency_p95 = 5 + queuing + backhaul.delay_ms + gauss(0, 0.5)
```
Quadratic queuing onset at 70% PRB; backhaul delay adds directly.

**Packet Loss**
```
radio_loss   = 5.0 × ((prb_util − 90) / 10)²  [if prb_util > 90]
             = uniform(0, 0.2)                   [otherwise]
packet_loss  = min(20, radio_loss + backhaul.loss_pct)
```

**CPU Load**
```
cpu_load = (ues_on_cell / 30) × 50 + prb_util × 0.4 + gauss(0, 1.5)
```
30 UEs = capacity reference.

**Handover Fail Rate**
```
ho_fail_rate = ho_failures / ho_attempts  [0.0 if no attempts]
```
Counters accumulated by `MobilityProcess`. Near-zero `a3_offset` lowers handover threshold → more attempts → more failures.

**SLA Violation**
```
sla_violation = prb_util > 95
             OR sinr_db < 0
             OR latency_p95 > min(slice SLA latency)
```
`min(slice SLA latency)` = 20 ms (slice-premium dominates).

### Output Destinations

- **InfluxDB** — measurement `cell_kpi`, tagged by `cell_id` and `energy_mode`
- **Kafka** — topic `aura.kpi.v1`, one JSON message per cell per tick
- **REST** — `GET /metrics` (in-memory ring buffer, last 60 ticks per cell)

---

## REST Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Service status, tick counter, connectivity |
| GET | `/metrics` | Latest KPIs (all cells or single cell) |
| GET | `/topology` | Network topology (all or single entity) |
| GET | `/events` | Recent network events |
| GET | `/snapshot` | Full WorldState snapshot |
| POST | `/whatif/run` | What-if simulation on a cloned WorldState |
| POST | `/actions/apply_slice_policy` | Update slice min/max BW or priority |
| POST | `/actions/tune_handover` | Update A3 offset / TTT for a cell |
| POST | `/actions/enable_energy_saving` | Set cell energy mode |
| POST | `/actions/rollback` | Revert a change by change ID |
| POST | `/fault/inject` | Inject a named fault scenario |
| POST | `/fault/restore` | Restore a named fault scenario |
| POST | `/fault/inject-agent` | Inject ephemeral fault and trigger AI agent pipeline |

---

## Fault Injector

The fault injector mutates `WorldState` directly via `POST /fault/inject` and `POST /fault/restore`. All scenarios are instantaneous and reversible.

> **Note on persistence:** `energy_saving_failure` and `mobility_storm` mutate cell state directly (`energy_mode`, `a3_offset`) so they persist across ticks without the pin mechanism. `evening_congestion` uses `pinned_loads` because `current_load` is overwritten by the dataset loader every tick.

---

### `evening_congestion`

Spikes load to 0.98 on three adjacent cells (default: C00, C01, C10), saturating PRBs and triggering SLA violations.

**Inject:**
```powershell
Invoke-RestMethod -Method POST -Uri http://localhost:8001/fault/inject `
  -ContentType "application/json" `
  -Body '{"scenario": "evening_congestion", "params": {}}'
```

**Restore:**
```powershell
Invoke-RestMethod -Method POST -Uri http://localhost:8001/fault/restore `
  -ContentType "application/json" `
  -Body '{"scenario": "evening_congestion", "params": {}}'
```

**What to watch:** `prb_util` on C00/C01/C10 → ~98%, `sla_violation` → true, `throughput_mbps` collapse.

---

### `backhaul_degradation`

Degrades the backhaul link on a target cell — increases `delay_ms` and `loss_pct` on the `BackhaulLink` object. These feed directly into `latency_p95_ms` and `packet_loss_pct` formulas.

**Inject:**
```powershell
Invoke-RestMethod -Method POST -Uri http://localhost:8001/fault/inject `
  -ContentType "application/json" `
  -Body '{"scenario": "backhaul_degradation", "params": {"cell_id": "C00", "delay_ms": 150.0, "loss_pct": 5.0}}'
```

**Restore:**
```powershell
Invoke-RestMethod -Method POST -Uri http://localhost:8001/fault/restore `
  -ContentType "application/json" `
  -Body '{"scenario": "backhaul", "params": {"cell_id": "C00"}}'
```

Restore resets to defaults: `delay_ms=5.0`, `loss_pct=0.1`, `status=UP`.

**What to watch:** `latency_p95_ms` and `packet_loss_pct` spike in Grafana for C00.

---

### `mobility_storm`

Sets A3 offset near zero (default: 0.1 dB, normal: 3.0 dB) on a target cell. Near-zero threshold means UEs trigger handover attempts on tiny SINR differences → excessive attempts → high failure rate.

**Inject:**
```powershell
Invoke-RestMethod -Method POST -Uri http://localhost:8001/fault/inject `
  -ContentType "application/json" `
  -Body '{"scenario": "mobility_storm", "params": {"cell_id": "C11", "a3_offset": 0.1}}'
```

**Restore:**
```powershell
Invoke-RestMethod -Method POST -Uri http://localhost:8001/fault/restore `
  -ContentType "application/json" `
  -Body '{"scenario": "handover_params", "params": {"cell_id": "C11"}}'
```

Restore resets `a3_offset=3.0` and `ttt_ms=40.0`.

**What to watch:** `ho_fail_rate` on C11 climbs in Grafana.

---

### `policy_misconfiguration`

Inverts slice priorities: `slice-premium` → priority 9 (lowest), `slice-iot` → priority 1 (highest). IoT traffic gets premium scheduling resources; premium UEs starve.

**Inject:**
```powershell
Invoke-RestMethod -Method POST -Uri http://localhost:8001/fault/inject `
  -ContentType "application/json" `
  -Body '{"scenario": "policy_misconfiguration", "params": {}}'
```

**Restore:**
```powershell
Invoke-RestMethod -Method POST -Uri http://localhost:8001/fault/restore `
  -ContentType "application/json" `
  -Body '{"scenario": "slice_priorities", "params": {}}'
```

Restore resets `slice-premium` priority to 1, `slice-iot` to 9.

**Verify:** `GET /topology` — confirm `slice-iot.priority=1` and `slice-premium.priority=9` after inject; reversed after restore.

---

### `energy_saving_failure`

Forces a cell into `SLEEP` mode during peak load. In SLEEP, `effective_prb` drops to 30% of max (30 PRBs). With load at 0.95, `prb_util` immediately hits 100% (`0.95 × 100 / 30 × 100 > 100`).

**Inject:**
```powershell
Invoke-RestMethod -Method POST -Uri http://localhost:8001/fault/inject `
  -ContentType "application/json" `
  -Body '{"scenario": "energy_saving_failure", "params": {"cell_id": "C20"}}'
```

**Restore:**
```powershell
Invoke-RestMethod -Method POST -Uri http://localhost:8001/fault/restore `
  -ContentType "application/json" `
  -Body '{"scenario": "energy_mode", "params": {"cell_id": "C20"}}'
```

Restore sets `energy_mode=ACTIVE`.

**What to watch:** C20 `prb_util` → 100% immediately. `sinr_db` drops by 6 dB (SLEEP penalty). `sla_violation` → true.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TICK_INTERVAL_S` | `5` | Simulation tick interval in seconds |
| `INFLUXDB_URL` | `` | InfluxDB endpoint (optional) |
| `INFLUXDB_TOKEN` | `` | InfluxDB auth token |
| `INFLUXDB_ORG` | `orion` | InfluxDB organization |
| `INFLUXDB_BUCKET` | `orion` | InfluxDB bucket |
| `KAFKA_BOOTSTRAP_SERVERS` | `` | Kafka brokers (optional) |
| `AGENT_URL` | `http://ai-agent:8003` | AI agent service URL |
| `DATASET_DIR` | `/data/telecom` | Path to load-factor CSVs |
