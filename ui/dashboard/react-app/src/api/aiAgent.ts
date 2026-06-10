import { AGENT_BASE } from '../config'

export interface PendingApproval {
  incident_id: string
  thread_id: string
  reasons: string[]
  blast_radius: number
  evaluated_rules: string[]
  requested_at: string
}

export interface AgentEvent {
  event_id: string
  correlation_id: string
  event_type: string
  entity_id: string
  severity_hint: string
  sim_time_s: number
  timestamp: string
  extra?: Record<string, unknown>
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${AGENT_BASE}${path}`)
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
  return r.json()
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${AGENT_BASE}${path}`, {
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

export const agentApi = {
  health: () => get<{ status: string }>('/health'),

  memory: (entityId = 'C00', n = 10) =>
    get<{ entity_id: string; count: number; snapshots: unknown[] }>(
      `/memory?entity_id=${encodeURIComponent(entityId)}&n=${n}`
    ),

  runPipeline: (event: AgentEvent) =>
    post<Record<string, unknown> & { status?: string; incident_id?: string; approve_url?: string }>('/run', event),

  approveDecision: (incidentId: string, decision: 'approved' | 'rejected', approver: string) =>
    post<{ status: string; incident_id: string; thread_id: string; decision: string; approver: string; pipeline_halted: boolean }>(
      `/approvals/${encodeURIComponent(incidentId)}/decision`,
      { decision, approver },
    ),

  pendingApprovals: () =>
    get<{ pending: PendingApproval[]; count: number }>('/approvals/pending'),
}
