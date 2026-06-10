import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { agentApi, type PendingApproval } from '../api/aiAgent'
import { twinApi } from '../api/digitalTwin'
import { POLL_FAST, POLL_SLOW } from '../config'

const SCENARIOS = [
  'evening_congestion',
  'backhaul_degradation',
  'mobility_storm',
  'policy_misconfiguration',
  'energy_saving_failure',
]

const PIPELINE_STAGES = ['Triage', 'RCA', 'Planner', 'Safety', 'Human Approval', 'Executor', 'Verifier']

function JsonBox({ data }: { data: unknown }) {
  return (
    <pre className="bg-gray-900 dark:bg-black text-green-400 rounded-lg p-4 text-xs overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
      {JSON.stringify(data, null, 2)}
    </pre>
  )
}

function PipelineStageBar({ result }: { result: Record<string, unknown> | null }) {
  if (!result) return null
  const done = new Set<string>()
  if (result.incident_record)    done.add('Triage')
  if (result.rca_report)         done.add('RCA')
  if (result.action_plan)        done.add('Planner')
  if (result.policy_decision)    done.add('Safety')
  if (result.status === 'awaiting_approval') done.add('Human Approval')
  if (result.change_confirmation) done.add('Executor')
  if (result.verification_report) done.add('Verifier')
  const halted = Boolean(result.pipeline_halted)

  return (
    <div className="mt-3">
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">Pipeline stages:</div>
      <div className="flex flex-wrap gap-1">
        {PIPELINE_STAGES.map(stage => {
          const active = stage === 'Human Approval' && result.status === 'awaiting_approval'
          const isDone = done.has(stage)
          const cls = active
            ? 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 border border-amber-400 font-bold animate-pulse'
            : isDone
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200'
              : halted
                ? 'bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-600'
                : 'bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-600'
          return (
            <span key={stage} className={`px-2 py-0.5 rounded text-xs ${cls}`}>
              {active ? '⏳ ' : isDone ? '✓ ' : ''}{stage}
            </span>
          )
        })}
      </div>
    </div>
  )
}

function ApprovalCard({
  ap,
  approver,
  onDecide,
  isPending,
}: {
  ap: PendingApproval
  approver: string
  onDecide: (incidentId: string, decision: 'approved' | 'rejected') => void
  isPending: boolean
}) {
  return (
    <div className="border border-amber-300 dark:border-amber-700 rounded-lg p-4 bg-amber-50 dark:bg-amber-950">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-sm font-bold text-amber-900 dark:text-amber-200 bg-amber-100 dark:bg-amber-900 px-2 py-0.5 rounded font-mono">
              {ap.incident_id}
            </code>
            <span className="text-xs text-amber-700 dark:text-amber-400">
              blast_radius: <span className="font-semibold">{ap.blast_radius}</span>
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {new Date(ap.requested_at).toLocaleTimeString()}
            </span>
          </div>
          {ap.reasons.length > 0 && (
            <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              Reasons: {ap.reasons.join(' · ')}
            </div>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => onDecide(ap.incident_id, 'approved')}
            disabled={isPending}
            className="px-3 py-1.5 text-xs text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg font-semibold transition-all disabled:opacity-50"
          >
            ✓ Approve
          </button>
          <button
            onClick={() => onDecide(ap.incident_id, 'rejected')}
            disabled={isPending}
            className="px-3 py-1.5 text-xs text-white bg-red-600 hover:bg-red-700 rounded-lg font-semibold transition-all disabled:opacity-50"
          >
            ✗ Reject
          </button>
        </div>
      </div>
    </div>
  )
}

export default function AIAgent() {
  const health = useQuery({
    queryKey: ['agent', 'health'],
    queryFn: agentApi.health,
    refetchInterval: POLL_SLOW,
    retry: 1,
  })

  // Live pending approvals — polled every 5 s
  const pendingQ = useQuery({
    queryKey: ['agent', 'approvals', 'pending'],
    queryFn: agentApi.pendingApprovals,
    refetchInterval: POLL_FAST,
    retry: 1,
  })
  const pendingList: PendingApproval[] = pendingQ.data?.pending ?? []

  // Approval state
  const [approver, setApprover] = useState('ops@orion')
  const [approvalResults, setApprovalResults] = useState<Record<string, unknown>>({})
  const [approvalErrors, setApprovalErrors] = useState<Record<string, string>>({})

  const approvalMut = useMutation({
    mutationFn: ({ incidentId, decision }: { incidentId: string; decision: 'approved' | 'rejected' }) =>
      agentApi.approveDecision(incidentId, decision, approver),
    onSuccess: (d, vars) => {
      setApprovalResults(prev => ({ ...prev, [vars.incidentId]: d }))
      setApprovalErrors(prev => { const n = { ...prev }; delete n[vars.incidentId]; return n })
      pendingQ.refetch()
    },
    onError: (e: Error, vars) => {
      setApprovalErrors(prev => ({ ...prev, [vars.incidentId]: e.message }))
    },
  })

  // Fault injection trigger (primary)
  const [scenario, setScenario] = useState('evening_congestion')
  const [injectResult, setInjectResult] = useState<{ event_id: string; incident_id: string; note: string } | null>(null)
  const [injectError, setInjectError] = useState<Error | null>(null)

  const injectMut = useMutation({
    mutationFn: () => twinApi.injectAgentFault(scenario),
    onSuccess: (d) => { setInjectResult(d); setInjectError(null) },
    onError: (e: Error) => { setInjectError(e); setInjectResult(null) },
  })

  // Memory inspector
  const [memEntity, setMemEntity] = useState('C00')
  const memQ = useQuery({
    queryKey: ['agent', 'memory', memEntity],
    queryFn: () => agentApi.memory(memEntity, 10),
    refetchInterval: 10_000,
    retry: 1,
  })

  const isOnline = health.data?.status === 'ok'
  const inputCls = 'w-full border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500'
  const selectCls = inputCls + ' bg-gray-50 dark:bg-gray-700'

  return (
    <div className="space-y-6">

      {/* Health banner */}
      <div className={`rounded-xl p-4 border-2 ${
        isOnline         ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950'
        : health.isError ? 'border-red-400 bg-red-50 dark:bg-red-950'
        : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'
      }`}>
        <div className="flex items-center gap-2">
          <span className={`w-3 h-3 rounded-full ${
            isOnline ? 'bg-emerald-500 animate-pulse'
            : health.isError ? 'bg-red-500'
            : 'bg-gray-300 dark:bg-gray-600'
          }`} />
          <span className="font-semibold text-gray-800 dark:text-gray-200">AI Agent (LangGraph Orchestrator)</span>
          <span className="ml-auto text-sm text-gray-500 dark:text-gray-400">
            {health.isLoading ? 'Checking…' : isOnline ? 'Online' : 'Offline / Unreachable'}
          </span>
        </div>
        {health.isError && (
          <div className="mt-2 text-xs text-red-600 dark:text-red-400">
            Could not reach AI agent at /api/agent/health. Make sure the service is running.
          </div>
        )}
      </div>

      {/* ── Pending Approvals — live, polled every 5 s ─────────────────────── */}
      <div className={`rounded-xl border-2 p-5 transition-colors ${
        pendingList.length > 0
          ? 'border-amber-400 bg-amber-50 dark:bg-amber-950'
          : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'
      }`}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {pendingList.length > 0 ? (
              <span className="text-xl">⚠️</span>
            ) : (
              <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />
            )}
            <h2 className={`font-semibold ${pendingList.length > 0 ? 'text-amber-800 dark:text-amber-300' : 'text-gray-800 dark:text-gray-200'}`}>
              Pending Approvals
            </h2>
            <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
              pendingList.length > 0
                ? 'bg-amber-400 text-amber-900'
                : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
            }`}>
              {pendingQ.isFetching && pendingList.length === 0 ? '…' : pendingList.length}
            </span>
          </div>
          <span className="text-xs text-gray-400 dark:text-gray-500">
            Auto-refreshes every 5 s
          </span>
        </div>

        {pendingList.length === 0 ? (
          <div className="text-sm text-gray-400 dark:text-gray-500">
            {pendingQ.isError
              ? 'Could not fetch pending approvals (agent offline?)'
              : 'No pipelines awaiting approval right now.'}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-xs text-amber-700 dark:text-amber-400 mb-2">
              Safety Agent returned <code className="bg-amber-100 dark:bg-amber-900 px-1 rounded">ALLOW_WITH_APPROVAL</code> for the following incidents.
              Review and approve or reject:
            </div>
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Approver identity</label>
              <input
                value={approver}
                onChange={e => setApprover(e.target.value)}
                placeholder="ops@orion"
                className="border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500 w-60"
              />
            </div>
            {pendingList.map(ap => (
              <div key={ap.incident_id}>
                <ApprovalCard
                  ap={ap}
                  approver={approver}
                  onDecide={(id, decision) => approvalMut.mutate({ incidentId: id, decision })}
                  isPending={approvalMut.isPending && approvalMut.variables?.incidentId === ap.incident_id}
                />
                {approvalErrors[ap.incident_id] && (
                  <div className="mt-1 p-2 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded text-xs text-red-700 dark:text-red-400 font-mono">
                    {approvalErrors[ap.incident_id]}
                  </div>
                )}
                {approvalResults[ap.incident_id] && (
                  <div className="mt-1">
                    <JsonBox data={approvalResults[ap.incident_id]} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Trigger + Memory ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Fault Injection Trigger */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-5">
          <h2 className="font-semibold text-gray-800 dark:text-gray-200 mb-1">Inject Fault & Trigger Pipeline</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            Injects a synthetic fault into the Digital Twin, which fires a Kafka event to the AI Agent.
            Pipeline runs: Triage → RCA → Planner → Safety → [Human Approval] → Executor → Verifier.
            If Safety requires approval, it appears in the panel above.
          </p>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Fault Scenario</label>
              <select value={scenario} onChange={e => setScenario(e.target.value)} className={selectCls}>
                {SCENARIOS.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <button
              onClick={() => { setInjectResult(null); setInjectError(null); injectMut.mutate() }}
              disabled={injectMut.isPending || !isOnline}
              className="w-full py-2.5 text-sm text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg font-semibold transition-all disabled:opacity-50"
            >
              {injectMut.isPending ? '⏳ Injecting…' : '⚡ Inject Fault & Run Pipeline'}
            </button>
            {injectMut.isPending && (
              <div className="text-xs text-gray-500 dark:text-gray-400 text-center">
                Pipeline running asynchronously. Check Pending Approvals above.
              </div>
            )}
            {injectError && (
              <div className="p-2 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded text-xs text-red-700 dark:text-red-400 font-mono">
                {injectError.message}
              </div>
            )}
            {injectResult && (
              <div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Fault injected:</div>
                <div className="p-3 bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800 rounded text-xs space-y-1">
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Event ID: </span>
                    <code className="font-mono text-emerald-800 dark:text-emerald-300">{injectResult.event_id}</code>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Incident ID: </span>
                    <code className="font-mono text-emerald-800 dark:text-emerald-300">{injectResult.incident_id}</code>
                  </div>
                  <div className="text-gray-500 dark:text-gray-400">{injectResult.note}</div>
                </div>
                <div className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                  Pipeline running in background. If Safety requires approval, it will appear in the Pending Approvals panel above within ~30–90 s.
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Memory inspector */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-semibold text-gray-800 dark:text-gray-200">KPI Memory Store</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">In-memory KPI snapshots fed to the agent from the Digital Twin</p>
            </div>
            <input
              value={memEntity}
              onChange={e => setMemEntity(e.target.value)}
              placeholder="C00"
              className="border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm w-24 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          {memQ.isError && (
            <div className="text-sm text-gray-400 dark:text-gray-500">Memory store unavailable (agent offline?)</div>
          )}
          {memQ.data && (
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                {memQ.data.count} snapshots for entity{' '}
                <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded text-gray-800 dark:text-gray-200">{memQ.data.entity_id}</code>
              </div>
              <JsonBox data={memQ.data.snapshots} />
            </div>
          )}
        </div>
      </div>

      {/* Pipeline stage legend */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-5">
        <h2 className="font-semibold text-gray-800 dark:text-gray-200 mb-3">Pipeline Architecture</h2>
        <div className="flex flex-wrap gap-1 items-center text-xs text-gray-500 dark:text-gray-400">
          {PIPELINE_STAGES.map((stage, i) => (
            <span key={stage} className="flex items-center gap-1">
              <span className="px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">{stage}</span>
              {i < PIPELINE_STAGES.length - 1 && <span className="text-gray-300 dark:text-gray-600">→</span>}
            </span>
          ))}
        </div>
        <div className="mt-3 text-xs text-gray-400 dark:text-gray-500 space-y-1">
          <div>Safety returns <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">ALLOW</code> → pipeline proceeds to Executor automatically.</div>
          <div>Safety returns <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">ALLOW_WITH_APPROVAL</code> → pipeline pauses, appears in Pending Approvals above.</div>
          <div>Safety returns <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">DENY</code> → pipeline halted, no action taken.</div>
        </div>
      </div>

    </div>
  )
}
