# ORION — Web UI

React-based management console for the ORION Network Intelligence Platform.

## Stack

| Layer | Technology |
|---|---|
| Framework | React 18 + TypeScript |
| Build tool | Vite 5 |
| Styling | Tailwind CSS 3 (class-based dark mode) |
| Data fetching | TanStack Query 5 (auto-poll every 5 s) |
| Reverse proxy | Nginx (Docker) / Vite dev proxy (local) |

## Pages

| Page | What you can do |
|---|---|
| **Dashboard** | Per-cell multi-line KPI sparklines, live PRB bar chart, service health cards, recent events feed |
| **Digital Twin** | Per-cell KPI history bars, inject/restore fault scenarios, tune handover, set energy mode, apply slice policy |
| **AI Agent** | Inject faults to trigger the LangGraph pipeline, live pending-approvals panel (polls every 5 s), approve/reject human-approval gate, inspect KPI memory store |
| **Actuator** | Rollback via PostgreSQL or direct twin, apply slice policy / handover / energy mode with audit trail |

## Dark Mode

Toggle button (🌙/☀️) in the header. Applies a `dark` class to `<html>` — all Tailwind `dark:` variants activate and the body background switches to `#030712`.

## KPI Charts (Dashboard)

Seven per-cell SVG sparklines (last 60 data points, one point per 5 s poll). Each cell gets a distinct color; a legend maps cell IDs to colors.

| Chart | Notes |
|---|---|
| PRB Utilization (%) | One line per cell; red at > 80% |
| Throughput (Mbps) | One line per cell |
| Latency P95 (ms) | One line per cell; amber at > 100 ms |
| SINR (dB) | One line per cell |
| HO Fail Rate (%) | One line per cell |
| Packet Loss (%) | One line per cell |
| SLA Violations (count) | Aggregate single-line sparkline |

A sorted horizontal bar chart shows live PRB% for all cells, color-coded and annotated with SLA breach warnings.

## AI Agent Pipeline Flow

1. **Inject Fault & Run Pipeline** button calls `POST /api/twin/fault/inject-agent` on the Digital Twin with the selected scenario.
2. The Digital Twin injects the fault and fires a Kafka event to the AI Agent.
3. The AI Agent runs the LangGraph pipeline asynchronously: Triage → RCA → Planner → Safety → [Human Approval] → Executor → Verifier.
4. If Safety returns `ALLOW_WITH_APPROVAL`, the pipeline pauses and writes an approval request to Redis.
5. The **Pending Approvals** panel polls `GET /api/agent/approvals/pending` every 5 s and immediately displays any waiting incidents with Approve / Reject buttons.
6. Approving or rejecting POSTs to `/api/agent/approvals/{incident_id}/decision` and the pipeline resumes.

## Running locally (dev mode)

Requires backend services running (docker-compose or manually).

```bash
cd ui/dashboard/react-app
npm install
npm run dev
# → http://localhost:3000
```

Vite dev proxy:

| Path prefix | Target |
|---|---|
| `/api/twin/*` | `http://localhost:8001` (Digital Twin) |
| `/api/act/*` | `http://localhost:8003` (Actuator) |
| `/api/agent/*` | `http://localhost:8004` (AI Agent) |

In Docker the proxy targets are overridden via env vars to use Docker service names (`TWIN_TARGET`, `ACT_TARGET`, `AGENT_TARGET`).

## Running in Docker

The UI is part of the main `docker-compose.yml`.

```bash
# From repo root — first time or after changes
docker compose up --build

# Rebuild only UI + AI Agent after source changes
docker compose up -d --build react-app ai-agent

# Services:
#   http://localhost:3000  — ORION dashboard (Vite dev server)
#   http://localhost:80    — ORION dashboard (nginx)
#   http://localhost:3001  — Grafana
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
        ├── vite.config.ts     — dev proxy + Docker env var targets
        ├── tailwind.config.js — darkMode: 'class'
        └── src/
            ├── App.tsx        — dark mode toggle (html.dark via useEffect)
            ├── config.ts      — API base URLs + poll intervals
            ├── api/           — typed API clients (digitalTwin, actuator, aiAgent)
            ├── components/    — Header (dark toggle, Grafana link → :3001)
            └── pages/
                ├── Dashboard.tsx   — per-cell multi-line KPI sparklines + health
                ├── DigitalTwin.tsx — per-cell detail + fault injection
                ├── AIAgent.tsx     — fault trigger + live pending approvals
                └── Actuator.tsx    — rollback + manual actions
```

## KPIs displayed

`prb_util` · `throughput_mbps` · `sinr_db` · `latency_p95_ms` · `packet_loss_pct` · `ho_fail_rate` · `energy_mode` · `sla_violation`

Color coding: PRB > 80% → red, > 60% → amber. SLA breach rows highlighted red.

## Fault scenarios (Digital Twin page)

Cell-specific scenarios require a **Target Cell** selector. Params are sent automatically per scenario.

| Button | Scenario | Needs cell |
|---|---|---|
| Evening Congestion | Pins C00/C01/C10 load to ~98% | No |
| Backhaul Degradation | Sets delay 150 ms + loss 5% on target cell | Yes |
| Mobility Storm | Sets A3 offset to 0.1 dB on target cell | Yes |
| Policy Misconfig | Inverts slice-premium/slice-iot priorities | No |
| Energy Saving Failure | Forces target cell to SLEEP at peak load | Yes |

Each fault has a matching **Restore** button.

## Valid slice IDs

`slice-premium` · `slice-standard` · `slice-iot`

## Known limitations

- Collector service has no `/health` endpoint — always shown as unknown on Dashboard.
- KPI sparklines accumulate from page load only (in-memory, no historical backfill from InfluxDB).
