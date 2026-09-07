import type {
  CellKPI,
  ChangeRecord,
  FaultSurface,
  NetworkEvent,
  Topology,
  TwinHealth,
  UeDistribution,
  WhatIfReport,
} from './types'

export const TWIN_BASE = '/api/twin'

const GRAFANA_OVERRIDE_KEY = 'orion.grafanaUrl'

/**
 * Grafana is embedded from its own published origin rather than proxied, so the
 * twin stack keeps serving it at :3001 unchanged. Order: operator override ->
 * build-time env -> same host on the default Grafana port.
 */
export function grafanaBaseUrl(): string {
  try {
    const stored = window.localStorage.getItem(GRAFANA_OVERRIDE_KEY)
    if (stored) return stored.replace(/\/+$/, '')
  } catch {
    /* storage blocked — fall through */
  }
  const env = import.meta.env.VITE_GRAFANA_URL
  if (env) return env.replace(/\/+$/, '')
  return `${window.location.protocol}//${window.location.hostname}:3001`
}

export function setGrafanaBaseUrl(url: string): void {
  try {
    if (url.trim() === '') window.localStorage.removeItem(GRAFANA_OVERRIDE_KEY)
    else window.localStorage.setItem(GRAFANA_OVERRIDE_KEY, url.trim())
  } catch {
    /* storage blocked — the session keeps the default */
  }
}

/** ms between REST refreshes for things the WebSocket does not push. */
export const POLL_SLOW = 15_000

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${TWIN_BASE}${path}`)
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — GET ${path}`)
  return r.json() as Promise<T>
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${TWIN_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    let detail = `${r.status} ${r.statusText}`
    try {
      const parsed = (await r.json()) as { detail?: string }
      if (parsed.detail) detail = parsed.detail
    } catch {
      /* body was not JSON — keep the status line */
    }
    throw new Error(detail)
  }
  return r.json() as Promise<T>
}

export function telemetrySocketUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}${TWIN_BASE}/ws/telemetry`
}

export const twin = {
  health: () => get<TwinHealth>('/health'),

  metrics: () => get<{ kpis: CellKPI[]; pinned_loads: Record<string, number> }>('/metrics'),

  cellMetrics: (cellId: string, lastN = 60) =>
    get<{ cell_id: string; kpis: CellKPI[]; pinned_load: number | null }>(
      `/metrics?cell_id=${encodeURIComponent(cellId)}&last_n=${lastN}`,
    ),

  topology: () => get<Topology>('/topology'),

  events: (limit = 60) => get<{ events: NetworkEvent[] }>(`/events?limit=${limit}`),

  entityEvents: (entityId: string, limit = 20) =>
    get<{ events: NetworkEvent[] }>(
      `/events?entity_id=${encodeURIComponent(entityId)}&limit=${limit}`,
    ),

  changes: () => get<{ changes: ChangeRecord[]; count: number }>('/changes'),

  faults: () => get<FaultSurface>('/faults'),

  ues: () => get<UeDistribution>('/ues'),

  whatIf: (actionPlan: Record<string, unknown>, horizonTicks: number) =>
    post<WhatIfReport>('/whatif/run', { action_plan: actionPlan, horizon_ticks: horizonTicks }),

  applySlicePolicy: (body: {
    slice_id: string
    min_bw_pct?: number
    max_bw_pct?: number
    priority?: number
  }) => post<{ change_id: string; applied: unknown }>('/actions/apply_slice_policy', body),

  tuneHandover: (body: { cell_id: string; a3_offset?: number; ttt_ms?: number }) =>
    post<{ change_id: string; applied: unknown }>('/actions/tune_handover', body),

  setEnergyMode: (body: { cell_id: string; mode: string }) =>
    post<{ change_id: string; applied: unknown }>('/actions/enable_energy_saving', body),

  rollback: (changeId: string) =>
    post<{ rolled_back: string; record: ChangeRecord }>('/actions/rollback', {
      change_id: changeId,
    }),

  injectFault: (scenario: string, params: Record<string, unknown> = {}) =>
    post<{ injected: Record<string, unknown> }>('/fault/inject', { scenario, params }),

  restoreFault: (scenario: string, params: Record<string, unknown> = {}) =>
    post<{ restored: Record<string, unknown> }>('/fault/restore', { scenario, params }),

  injectAgentFault: (scenario = 'evening_congestion', cells?: string[]) =>
    post<{ event_id: string; incident_id: string; note: string }>('/fault/inject-agent', {
      scenario,
      cells,
    }),

  restoreAgentFault: (scenario = 'evening_congestion', cells?: string[]) =>
    post<{ restored: Record<string, unknown> }>('/fault/restore-agent', { scenario, cells }),
}
