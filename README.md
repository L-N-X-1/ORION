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

- [x] **M1** — Digital Twin + Telemetry ✅
- [ ] **M2** — Triage & Root Cause Agents
- [ ] **M3** — Planner + First Closed Loop
- [ ] **M4** — Safety Guardrails + Full Autonomy
- [ ] **M5** — 6G Extensions + Reinforcement Learning

## Quick start

```bash
git clone https://github.com/L-N-X-1/aura-net-lab.git
cd aura-net
make up
```

Services will be available at:

| Service       | URL                    |
|---------------|------------------------|
| API Gateway   | http://localhost:8000  |
| Grafana       | http://localhost:3001  |
| Digital Twin  | http://localhost:8001  |
| InfluxDB      | http://localhost:8086  |

---

## Digital Twin — getting started

> ✅ M1 complete — the digital twin is live and producing KPIs.

### 1. Download the dataset

Download the Milan mobile phone activity dataset from Kaggle and place the CSV files under `/data/csv/`:

```
https://www.kaggle.com/datasets/marcodena/mobile-phone-activity
```

```
aura-net/
└── data/
    └── csv/
    └── telecom/
        
```

### 2. Supported CSV format

The twin natively supports the **Italian Telecom 2013** dataset and any compatible CSV sharing the same schema:

| Column      | Type      | Description                        |
|-------------|-----------|------------------------------------|
| `CellID`    | integer   | Grid square identifier             |
| `Datetime`  | timestamp | UTC timestamp of the measurement   |
| `smsin`     | float     | Incoming SMS activity              |
| `smsout`    | float     | Outgoing SMS activity              |
| `callin`    | float     | Incoming call activity             |
| `callout`   | float     | Outgoing call activity             |
| `internet`  | float     | Internet traffic activity          |

Any CSV that follows this column structure (same names, same types) is accepted — the loader is not hardcoded to the Italian Telecom source. Bring your own compatible dataset and it will work out of the box.

### 3. Choose a data-loading mode

The twin supports two modes for mapping CSV rows to simulated cells, configured via `DATASET_SOURCES` in your `.env`.

| Mode | Description |
|------|-------------|
| **Auto-assign** | Load all CSVs from `/data/csv/` and let the twin distribute rows across cells automatically. Good for quick runs and exploratory testing. |
| **Dedicated-cell** | Explicitly bind each CSV (and a specific row filter) to a named cell. Better spatial fidelity and reproducible KPI traces per cell. |

### 4. Configure `DATASET_SOURCES`

Each entry follows the format `CellID:filepath:FilterColumn:FilterValue:DataType`, pipe-separated:

```dotenv
DATASET_SOURCES=C00:/data/telecom.csv:CellID:4455:internet|C01:/data/telecom.csv:CellID:4456:internet|C10:/data/telecom.csv:CellID:5055:internet|C11:/data/telecom.csv:CellID:5056:internet|C20:/data/smartmeter.csv:LCLid:MAC000002:energy|C21:/data/smartmeter.csv:LCLid:MAC000003:energy
```

Field breakdown:

| Field           | Description                              | Example               |
|-----------------|------------------------------------------|-----------------------|
| `CellID`        | Logical cell label used internally       | `C00`                 |
| `Filepath`      | Path to the CSV file                     | `/data/telecom.csv`   |
| `FilterColumn`  | Column to filter on                      | `CellID`              |
| `FilterValue`   | Row value to select                      | `4455`                |
| `DataType`      | Signal type hint for KPI generation      | `internet` / `energy` |

---

## Progress

Follow along on [LinkedIn](#https://www.linkedin.com/in/mohamed-rayen-ben-azouz-658667302/) as I build this milestone by milestone.

---

*Built as a home lab project exploring 5G network automation and agentic AI.*
