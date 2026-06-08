import { TWIN_BASE } from '../config'

export interface CellKPI {
  cell_id: string
  ts: string
  sim_time_s: number
  prb_util: number
  throughput_mbps: number
  sinr_db: number
  cqi: number
  latency_p95_ms: number
  packet_loss_pct: number
  cpu_load_pct: number
  ho_fail_rate: number
  energy_mode: 'ACTIVE' | 'SLEEP' | 'SHUTDOWN'
  sla_violation: boolean
  is_peak: boolean
}

export interface TwinHealth {
  status: string
  service: string
  sim_time_s: number
  tick: number
  cells: number
  tick_interval_s: number
  kafka: string
  influxdb: string
  dataset_sources: string[]
}

export interface NetworkEvent {
  event_id: string
  event_type: string
  entity_id: string
  severity?: string
  timestamp: string
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${TWIN_BASE}${path}`)
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
  return r.json()
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${TWIN_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const msg = await r.text()
    throw new Error(`${r.status}: ${msg}`)
  }
  return r.json()
}

export const twinApi = {
  health: () => get<TwinHealth>('/health'),

  metrics: () => get<{ kpis: CellKPI[]; pinned_loads: Record<string, number> }>('/metrics'),

  cellMetrics: (cellId: string, lastN = 20) =>
    get<{ cell_id: string; kpis: CellKPI[]; pinned_load: number | null }>(
      `/metrics?cell_id=${encodeURIComponent(cellId)}&last_n=${lastN}`
    ),

  events: (limit = 50) => get<{ events: NetworkEvent[] }>(`/events?limit=${limit}`),

  snapshot: () => get<Record<string, unknown>>('/snapshot'),

  injectFault: (scenario: string, params: Record<string, unknown> = {}) =>
    post<{ injected: unknown }>('/fault/inject', { scenario, params }),

  restoreFault: (scenario: string, params: Record<string, unknown> = {}) =>
    post<{ restored: unknown }>('/fault/restore', { scenario, params }),

  injectAgentFault: (scenario = 'evening_congestion', cells?: string[]) =>
    post<{ event_id: string; incident_id: string; note: string }>('/fault/inject-agent', { scenario, cells }),

  applySlicePolicy: (sliceId: string, minBw?: number, maxBw?: number, priority?: number) =>
    post<{ change_id: string }>('/actions/apply_slice_policy', {
      slice_id: sliceId, min_bw_pct: minBw, max_bw_pct: maxBw, priority,
    }),

  tuneHandover: (cellId: string, a3Offset?: number, tttMs?: number) =>
    post<{ change_id: string }>('/actions/tune_handover', {
      cell_id: cellId, a3_offset: a3Offset, ttt_ms: tttMs,
    }),

  enableEnergySaving: (cellId: string, mode: string) =>
    post<{ change_id: string }>('/actions/enable_energy_saving', { cell_id: cellId, mode }),

  rollback: (changeId: string) =>
    post<{ rolled_back: string }>('/actions/rollback', { change_id: changeId }),
}
