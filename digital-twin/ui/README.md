# ORION Twin Console

React + TypeScript operator console for the ORION digital twin. It is the
twin's own front end: live network state, per-cell drill-down, and the control
surface for slice policy, handover tuning, energy mode, fault injection and
what-if forecasting.

**Dev port:** `5173`  **Container port:** `80` (published on `8080` by default)

---

## Why this exists alongside Grafana

They answer different questions and both stay.

| | Twin Console | Grafana |
|---|---|---|
| Question | What is the network doing *right now*, and what happens if I change it? | What did the network do over the last hours or days? |
| Source | Twin REST + WebSocket, in-memory world state | InfluxDB, written every tick |
| Interaction | Read **and write** — actions mutate the twin | Read-only |
| Strength | Topology, causality, control, forecasting | Long-range history, ad-hoc querying, alerting |

The console's **Analytics** page embeds the provisioned Grafana dashboard so
both live in one browser tab. Nothing about the Grafana stack changed except
two flags that permit embedding.

---

## Architecture

```
                    digital-twin (FastAPI, :8001)
                    │
        REST  ──────┼────── WebSocket /ws/telemetry
        /metrics    │       one frame per tick
        /topology   │
        /events     │
        /changes    │
        /faults     │
        /ues        │
        /whatif/run │
        /actions/*  │
        /fault/*    │
                    ▼
              Twin Console (React 18 + TS + Vite)
              nginx serves the bundle, proxies /api/twin/*
              and /grafana/* (Grafana's JSON API only)

                    InfluxDB ──► Grafana (:3001)
                                 embedded in the Analytics page
```

**Telemetry transport.** `src/api/telemetry.tsx` opens the WebSocket and keeps a
per-cell ring buffer of the last 240 ticks. If the socket cannot open or drops,
it falls back to polling `/metrics` + `/events` every 5 s and retries the socket
every 8 s, so the console degrades instead of going blank. History is seeded
once at mount from `/metrics?cell_id=…&last_n=60` so charts are populated before
the first frame arrives.

**Writes** go through TanStack Query mutations, which invalidate the change and
fault queries so the change log and deviation list stay honest.

---

## Pages

| Route | What it is for |
|---|---|
| `/` Overview | Network roll-up: stat tiles, aggregate throughput with SLA breach bars, top-loaded PRB lines, per-cell sparkline grid, cross-KPI matrix, live event stream |
| `/topology` | Interactive hex canvas of the 12-cell grid with switchable KPI layers, plus an inspector that acts on the selected cell |
| `/cells` | Sortable register of every cell and every KPI |
| `/cells/:id` | Per-cell drill-down: four paired-KPI charts, controls, backhaul, neighbours, entity events |
| `/slices` | Slice envelopes, policy editor, UE distribution, slice change history |
| `/mobility` | Handover attempts/failures, A3 offset vs failure-rate scatter, per-cell mobility register with one-click restore |
| `/faults` | Active deviation list, the five scenario injectors, the agent hand-off trigger, and the change log with rollback |
| `/what-if` | Action-plan builder that runs `/whatif/run` and renders baseline vs with-action deltas |
| `/analytics` | Every panel from the provisioned Grafana dashboard, or the full dashboard in kiosk mode, with a configurable base URL |

---

**Grafana embeds.** The Analytics page reads the dashboard's panel list from
Grafana's API at runtime and renders every panel it finds, mirroring the
dashboard's own 24-column layout on a 6-column grid. A panel added to the
dashboard appears here with no front-end change. Grafana sends no CORS headers,
so that API call goes through a same-origin `/grafana/` proxy in nginx (and the
Vite dev proxy); the iframes themselves still load from Grafana's own origin,
which avoids having to move Grafana onto a URL sub-path. If the API cannot be
reached the page falls back to a static list of the twelve provisioned panels
and says so in its header.

---

## Design system

Deliberately not the default dark-SaaS look. The console reads as instrument
panel: warm graphite chassis, one accent, monospace numerics.

**Palette** (`tailwind.config.js`, mirrored in `src/lib/status.ts` for canvas
and chart code that needs raw hex):

| Token | Hex | Role |
|---|---|---|
| `void` / `panel` / `raise` | `#0B0A09` `#121110` `#1E1C19` | Warm graphite, not blue-slate |
| `line` / `line2` | `#262320` `#332F2A` | Hairlines and bezels |
| `ink` / `ink2` / `ink3` | `#F0EAE0` `#9E978B` `#6A645B` | Text ramp |
| `amber` | `#FFB01F` | Attention and interaction — never "all good" |
| `teal` | `#3FBFA8` | Nominal |
| `coral` | `#FF5F52` | Critical |
| `steel` `sand` `lime` `clay` | | Extra chart series |

**Rules the whole app follows**

- Every number is monospace and tabular (`.num`), so columns align and digits
  do not jitter between ticks.
- Section labels are 10px uppercase mono with wide tracking (`.label`).
- Panels are 1px-bordered rectangles with corner registration ticks. Radius is
  2px. No gradients, no glow, no drop shadows.
- Status is a square LED, not a rounded pill.
- Thresholds live in one place, `src/lib/status.ts`, and are aligned with
  `event_generator.py` so the UI never shows "nominal" for a KPI the twin is
  already raising an event on.

**Topology canvas** is hand-written SVG rather than a graph library. The twin's
neighbour list is 4-connected, so cells sit on a spaced grid and every link
renders as a readable orthogonal segment. Wheel zooms, drag pans, and a 4px
slop threshold keeps a pan from selecting a cell on release.

---

## Running it

**With the stack** (built and served by nginx):

```bash
cd digital-twin
docker compose up --build -d
# console  http://localhost:8080
# twin API http://localhost:8001
# grafana  http://localhost:3001
```

**Dev server** against a stack that is already up:

```bash
make ui-dev          # or: cd ui && npm install && npm run dev
# http://localhost:5173
```

Vite proxies `/api/twin` to `localhost:8001` (override with `TWIN_TARGET`) and
handles the WebSocket upgrade on the same path.

**Checks:**

```bash
npm run typecheck    # tsc --noEmit
npm run build        # typecheck + production bundle
```

---

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `TWIN_UI_PORT` | compose | Host port for the console (default `8080`) |
| `TWIN_UI_GRAFANA_URL` | compose build arg | Grafana URL baked into the bundle. Blank falls back to `<current host>:3001` |
| `TWIN_TARGET` | dev only | Twin origin the Vite proxy forwards to |

The Analytics page also accepts a per-browser Grafana URL override, stored in
`localStorage`, for when the stack runs on another machine.

---

## Known gaps

- `NetworkSlice.current_load` is never written by the simulator, so slice load
  reads 0. The UI labels it rather than hiding it.
- Embedding needs `GF_SECURITY_ALLOW_EMBEDDING=true` and anonymous viewer
  access. The twin's compose file sets both; a Grafana started by hand will
  render an empty iframe without them.
- The provisioned dashboard sets `fillOpacity: 10` on all eight timeseries
  panels. With twelve series per panel the fills stack into a solid band that
  swallows the lines. It renders that way in Grafana directly too, so it is a
  dashboard-side setting rather than something the embed introduces.
- The console talks only to the digital twin. It does not reach the
  agentic-ai stack, so the Faults page's agent hand-off only completes once
  the two stacks share a network.
