import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { agentApi, type AgentEvent } from '../api/aiAgent'
import { POLL_SLOW } from '../config'

const EVENT_TYPES = ['CONGESTION', 'BACKHAUL_DEGRADATION', 'OUTAGE', 'HO_FAILURE', 'SIGNAL_DEGRADATION']
const SEVERITIES  = ['low', 'medium', 'high', 'critical']

function genId() { return Math.random().toString(36).slice(2, 10) }

function JsonBox({ data }: { data: unknown }) {
  return (
    <pre className="bg-gray-900 text-green-400 rounded-lg p-4 text-xs overflow-x-auto max-h-96 whitespace-pre-wrap break-all">
      {JSON.stringify(data, null, 2)}
    </pre>
  )
}

export default function AIAgent() {
  const health = useQuery({
    queryKey: ['agent', 'health'],
    queryFn: agentApi.health,
    refetchInterval: POLL_SLOW,
    retry: 1,
  })

  // Memory inspector
  const [memEntity, setMemEntity] = useState('C00')
  const memQ = useQuery({
    queryKey: ['agent', 'memory', memEntity],
    queryFn: () => agentApi.memory(memEntity, 10),
    refetchInterval: 10_000,
    retry: 1,
  })

  // Pipeline trigger
  const [evType,    setEvType]    = useState('CONGESTION')
  const [evEntity,  setEvEntity]  = useState('C00')
  const [evSev,     setEvSev]     = useState('high')
  const [pipeResult, setPipeResult] = useState<unknown>(null)
  const [pipeError,  setPipeError]  = useState<Error | null>(null)

  const pipeMut = useMutation({
    mutationFn: () => {
      const now = new Date().toISOString()
      const event: AgentEvent = {
        event_id:       `evt-ui-${genId()}`,
        correlation_id: `evt-ui-${genId()}`,
        event_type:     evType,
        entity_id:      evEntity,
        severity_hint:  evSev,
        sim_time_s:     0,
        timestamp:      now,
        extra:          { source: 'orion-ui' },
      }
      return agentApi.runPipeline(event)
    },
    onSuccess: (d) => { setPipeResult(d); setPipeError(null) },
    onError:   (e: Error) => { setPipeError(e); setPipeResult(null) },
  })

  // Approval form
  const [approvalId,       setApprovalId]       = useState('')
  const [approvalDecision, setApprovalDecision] = useState<'approved' | 'rejected'>('approved')
  const [approvalBy,       setApprovalBy]       = useState('ops@orion')
  const [approvalResult,   setApprovalResult]   = useState<unknown>(null)
  const [approvalError,    setApprovalError]    = useState<Error | null>(null)

  const approvalMut = useMutation({
    mutationFn: ({ decision, approver }: { decision: 'approved' | 'rejected'; approver: string }) =>
      agentApi.approveDecision(approvalId, decision, approver),
    onSuccess: (d) => { setApprovalResult(d); setApprovalError(null) },
    onError:   (e: Error) => { setApprovalError(e); setApprovalResult(null) },
  })

  const isOnline = health.data?.status === 'ok'

  return (
    <div className="space-y-6">

      {/* Health */}
      <div className={`rounded-xl p-4 border-2 ${isOnline ? 'border-emerald-400 bg-emerald-50' : health.isError ? 'border-red-400 bg-red-50' : 'border-gray-200 bg-white'}`}>
        <div className="flex items-center gap-2">
          <span className={`w-3 h-3 rounded-full ${isOnline ? 'bg-emerald-500 animate-pulse' : health.isError ? 'bg-red-500' : 'bg-gray-300'}`} />
          <span className="font-semibold text-gray-800">AI Agent (LangGraph Orchestrator)</span>
          <span className="ml-auto text-sm text-gray-500">
            {health.isLoading ? 'Checking…' : isOnline ? 'Online' : 'Offline / Unreachable'}
          </span>
        </div>
        {health.isError && (
          <div className="mt-2 text-xs text-red-600">
            Could not reach AI agent at /api/agent/health. Make sure the service is running.
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Trigger pipeline */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <h2 className="font-semibold text-gray-800 mb-1">Trigger Agent Pipeline</h2>
          <p className="text-xs text-gray-500 mb-4">
            Manually fire a NetworkEvent into the LangGraph pipeline:
            Triage → RCA → Planner → Safety → Executor → Verifier
          </p>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Event Type</label>
              <select value={evType} onChange={e => setEvType(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500">
                {EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">Entity (Cell ID)</label>
                <input value={evEntity} onChange={e => setEvEntity(e.target.value)} placeholder="C00"
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Severity</label>
                <select value={evSev} onChange={e => setEvSev(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500">
                  {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <button
              onClick={() => pipeMut.mutate()}
              disabled={pipeMut.isPending || !isOnline}
              className="w-full py-2.5 text-sm text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg font-semibold transition-all disabled:opacity-50"
            >
              {pipeMut.isPending ? '⏳ Running pipeline…' : '▶ Run Pipeline'}
            </button>
            {pipeMut.isPending && (
              <div className="text-xs text-gray-500 text-center">
                Pipeline can take 30–120 s depending on LLM speed. If human approval is needed, status 202 is returned.
              </div>
            )}
            {pipeError && (
              <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700 font-mono">
                {pipeError.message}
              </div>
            )}
            {pipeResult && (
              <div>
                <div className="text-xs text-gray-500 mb-1">Pipeline result:</div>
                <JsonBox data={pipeResult} />
              </div>
            )}
          </div>
        </div>

        {/* Human approval gate */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <h2 className="font-semibold text-gray-800 mb-1">Human Approval Gate</h2>
          <p className="text-xs text-gray-500 mb-4">
            When the Safety Agent returns ALLOW_WITH_APPROVAL, the pipeline pauses.
            Enter the incident ID from the 202 response to approve or reject.
          </p>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Incident ID</label>
              <input value={approvalId} onChange={e => setApprovalId(e.target.value)} placeholder="INC-xxxxxxxx"
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">Decision</label>
                <select value={approvalDecision} onChange={e => setApprovalDecision(e.target.value as 'approved' | 'rejected')}
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Approver</label>
                <input value={approvalBy} onChange={e => setApprovalBy(e.target.value)} placeholder="ops@orion"
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => approvalMut.mutate({ decision: 'approved', approver: approvalBy })}
                disabled={!approvalId || approvalMut.isPending}
                className="flex-1 py-2 text-sm text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg font-medium transition-all disabled:opacity-50"
              >
                ✓ Approve
              </button>
              <button
                onClick={() => approvalMut.mutate({ decision: 'rejected', approver: approvalBy })}
                disabled={!approvalId || approvalMut.isPending}
                className="flex-1 py-2 text-sm text-white bg-red-600 hover:bg-red-700 rounded-lg font-medium transition-all disabled:opacity-50"
              >
                ✗ Reject
              </button>
            </div>
            {approvalError && (
              <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700 font-mono">{approvalError.message}</div>
            )}
            {approvalResult && <JsonBox data={approvalResult} />}
          </div>
        </div>
      </div>

      {/* Memory inspector */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="font-semibold text-gray-800">KPI Memory Store</h2>
            <p className="text-xs text-gray-500">In-memory KPI snapshots fed to the agent from the Digital Twin</p>
          </div>
          <div className="flex items-center gap-2">
            <input value={memEntity} onChange={e => setMemEntity(e.target.value)} placeholder="C00"
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm w-24 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>
        {memQ.isError && (
          <div className="text-sm text-gray-400">Memory store unavailable (agent offline?)</div>
        )}
        {memQ.data && (
          <div>
            <div className="text-xs text-gray-500 mb-2">
              {memQ.data.count} snapshots for entity <code className="bg-gray-100 px-1 rounded">{memQ.data.entity_id}</code>
            </div>
            <JsonBox data={memQ.data.snapshots} />
          </div>
        )}
      </div>
    </div>
  )
}
