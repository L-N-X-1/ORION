# ORION — Web UI

React-based management console for the ORION Network Intelligence Platform.

## Stack

| Layer | Technology |
|---|---|
| Framework | React 18 + TypeScript |
| Build tool | Vite 5 |
| Styling | Tailwind CSS 3 |
| Data fetching | TanStack Query 5 (auto-poll every 5 s) |
| Reverse proxy | Nginx (Docker) / Vite dev proxy (local) |

## Pages

| Page | What you can do |
|---|---|
| **Dashboard** | Live KPI table, SVG sparkline trends, PRB bar chart by cell, live service health for all services, recent events |
| **Digital Twin** | Per-cell KPI history bars, inject/restore fault scenarios with correct cell params, tune handover, set energy mode, apply slice policy |
| **AI Agent** | Trigger LangGraph pipeline, approve/reject human-approval gate (race-condition-free), inspect KPI memory store |
| **Actuator** | Rollback via PostgreSQL or direct twin, apply slice policy / handover / energy mode with audit trail |

## KPI Charts (Dashboard)

Four live SVG sparklines (last 60 data points, one per 5 s poll):

| Chart | Color |
|---|---|
| Avg PRB Utilization | Red |
| Avg Throughput (Mbps) | Blue |
| SLA Violation count | Amber |
| Avg Latency P95 (ms) | Purple |

Plus a sorted horizontal bar chart showing PRB% for all 24 cells, color-coded and annotated with SLA breach warnings.

## Running locally (dev mode)

Requires the backend services running (docker-compose or manually).

```bash
cd ui/dashboard/react-app
npm install
npm run dev
# → http://localhost:3000
```

The Vite dev server proxies API calls:

| Path prefix | Target |
|---|---|
| `/api/twin/*` | `http://localhost:8001` (Digital Twin) |
| `/api/act/*` | `http://localhost:8003` (Actuator) |
| `/api/agent/*` | `http://localhost:8004` (AI Agent) |

## Running in Docker

The UI is part of the main `docker-compose.yml`. Nginx at port 80 serves the React app and proxies all API routes.

```bash
# From repo root — first time or after changes
docker compose up --build

# Rebuild only UI services after source changes
docker compose up --build react-app nginx

# UI available at:
#   http://localhost           — ORION dashboard
#   http://localhost/grafana/  — Grafana (existing dashboards)
```

## Directory structure

```
ui/
├── README.md                  ← you are here
├── nginx/
│   ├── Dockerfile
│   └── nginx.conf             — proxy routes for all services
└── dashboard/
    ├── grafana/
    │   └── provisioning/      — Grafana datasource config
    └── react-app/
        ├── package.json
        ├── vite.config.ts     — dev proxy config
        ├── tailwind.config.js
        └── src/
            ├── App.tsx
            ├── config.ts      — API base URLs + poll intervals
            ├── api/           — typed API clients (digitalTwin, actuator, aiAgent)
            ├── components/    — Header, service status dots
            └── pages/
                ├── Dashboard.tsx   — KPI charts + sparklines + health
                ├── DigitalTwin.tsx — per-cell detail + fault injection
                ├── AIAgent.tsx     — pipeline trigger + approval gate
                └── Actuator.tsx    — rollback + manual actions
```

## KPIs displayed

`prb_util` · `throughput_mbps` · `sinr_db` · `latency_p95_ms` · `packet_loss_pct` · `ho_fail_rate` · `energy_mode` · `sla_violation`

Color coding: PRB > 80% → red, > 60% → amber. SLA breach rows highlighted red.

## Fault scenarios (Digital Twin page)

Cell-specific scenarios require a **Target Cell** selector (shown above the buttons). The correct params are sent automatically per scenario.

| Button | Scenario | Needs cell |
|---|---|---|
| Evening Congestion | Pins C00/C01/C10 load to ~98% | No |
| Backhaul Degradation | Sets delay 150 ms + loss 5% on target cell | Yes |
| Mobility Storm | Sets A3 offset to 0.1 dB on target cell | Yes |
| Policy Misconfig | Inverts slice-premium/slice-iot priorities | No |
| Energy Saving Failure | Forces target cell to SLEEP at peak load | Yes |

Each fault has a matching **Restore** button that sends the correct restore scenario name and cell params to the twin.

The **Inject Fault + Trigger AI Pipeline** button injects `evening_congestion` and fires the full LangGraph pipeline automatically via `/fault/inject-agent`.

## Valid slice IDs

`slice-premium` · `slice-standard` · `slice-iot`

All slice policy forms (Digital Twin and Actuator pages) use a dropdown restricted to these values.

## Known limitations

- Collector service has no `/health` endpoint exposed — always shown as unknown on Dashboard.
- KPI sparklines accumulate from page load only (in-memory, no historical backfill from InfluxDB).
