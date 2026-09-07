import { ACT_BASE } from '../config'

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${ACT_BASE}${path}`)
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
  return r.json()
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${ACT_BASE}${path}`, {
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

export const actuatorApi = {
  health: () => get<{ status: string; service: string }>('/health'),

  rollback: (incidentId: string, changeId: string) =>
    post<{ rolled_back: string }>('/actions/rollback', {
      incident_id: incidentId,
      change_id: changeId,
    }),

  applySlicePolicy: (incidentId: string, sliceId: string, minBw?: number, maxBw?: number, priority?: number) =>
    post<{ change_id: string }>('/actions/apply_slice_policy', {
      incident_id: incidentId, slice_id: sliceId,
      min_bw_pct: minBw, max_bw_pct: maxBw, priority,
    }),

  tuneHandover: (incidentId: string, cellId: string, a3Offset?: number, tttMs?: number) =>
    post<{ change_id: string }>('/actions/tune_handover', {
      incident_id: incidentId, cell_id: cellId,
      a3_offset: a3Offset, ttt_ms: tttMs,
    }),

  enableEnergySaving: (incidentId: string, cellId: string, mode: string) =>
    post<{ change_id: string }>('/actions/enable_energy_saving', {
      incident_id: incidentId, cell_id: cellId, mode,
    }),
}
