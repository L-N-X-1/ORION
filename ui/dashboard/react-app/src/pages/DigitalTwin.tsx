import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { twinApi } from '../api/digitalTwin'
import { POLL_FAST } from '../config'

const SLICE_IDS = ['slice-premium', 'slice-standard', 'slice-iot']

// Scenarios that require a target cell_id
const FAULT_SCENARIOS = [
  { id: 'evening_congestion',      label: 'Evening Congestion',    color: 'bg-amber-500 hover:bg-amber-600',  needsCell: false },
  { id: 'backhaul_degradation',    label: 'Backhaul Degradation',  color: 'bg-orange-500 hover:bg-orange-600', needsCell: true },
  { id: 'mobility_storm',          label: 'Mobility Storm',        color: 'bg-red-500 hover:bg-red-600',      needsCell: true },
  { id: 'policy_misconfiguration', label: 'Policy Misconfig',      color: 'bg-purple-500 hover:bg-purple-600', needsCell: false },
  { id: 'energy_saving_failure',   label: 'Energy Saving Failure', color: 'bg-pink-500 hover:bg-pink-600',    needsCell: true },
]

const RESTORE_SCENARIOS = [
  { id: 'evening_congestion', label: 'Restore Congestion',      needsCell: false },
  { id: 'backhaul',           label: 'Restore Backhaul',        needsCell: true },
  { id: 'energy_mode',        label: 'Restore Energy Mode',     needsCell: true },
  { id: 'handover_params',    label: 'Restore Handover',        needsCell: true },
  { id: 'slice_priorities',   label: 'Restore Slice Priority',  needsCell: false },
]

function faultParams(scenario: string, cellId: string): Record<string, unknown> {
  switch (scenario) {
    case 'backhaul_degradation':  return { cell_id: cellId, delay_ms: 150.0, loss_pct: 5.0 }
    case 'mobility_storm':        return { cell_id: cellId, a3_offset: 0.1 }
    case 'energy_saving_failure': return { cell_id: cellId }
    default:                      return {}
  }
}

function restoreParams(scenario: string, cellId: string): Record<string, unknown> {
  switch (scenario) {
    case 'backhaul':        return { cell_id: cellId }
    case 'energy_mode':     return { cell_id: cellId }
    case 'handover_params': return { cell_id: cellId }
    default:                return {}
  }
}

const ENERGY_MODES = ['ACTIVE', 'SLEEP', 'SHUTDOWN']

function fmt(n: number, dp = 1) { return n.toFixed(dp) }

function ActionResult({ result, error }: { result?: unknown; error?: Error | null }) {
  if (error) return (
    <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700 font-mono break-all">
      {error.message}
    </div>
  )
  if (result) return (
    <div className="mt-2 p-2 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-700 font-mono break-all">
      {JSON.stringify(result, null, 2)}
    </div>
  )
  return null
}

export default function DigitalTwin() {
  const qc = useQueryClient()

  const health  = useQuery({ queryKey: ['twin', 'health'],  queryFn: twinApi.health,  refetchInterval: 10_000 })
  const metrics = useQuery({ queryKey: ['twin', 'metrics'], queryFn: twinApi.metrics, refetchInterval: POLL_FAST })

  const cells = metrics.data?.kpis.map(k => k.cell_id) ?? []
  const [selectedCell, setSelectedCell] = useState<string>('')
  const activeCell = selectedCell || cells[0] || ''

  const cellQ = useQuery({
    queryKey: ['twin', 'cell', activeCell],
    queryFn: () => twinApi.cellMetrics(activeCell, 20),
    enabled: !!activeCell,
    refetchInterval: POLL_FAST,
  })

  const eventsQ = useQuery({
    queryKey: ['twin', 'events'],
    queryFn: () => twinApi.events(30),
    refetchInterval: POLL_FAST,
  })

  // Fault injection — cell_id for cell-specific scenarios
  const [faultCell, setFaultCell] = useState('C00')
  const [faultResult, setFaultResult] = useState<unknown>(null)
  const [faultError,  setFaultError]  = useState<Error | null>(null)

  const faultMut = useMutation({
    mutationFn: ({ scenario, needsCell }: { scenario: string; needsCell: boolean }) =>
      twinApi.injectFault(scenario, needsCell ? faultParams(scenario, faultCell) : {}),
    onSuccess: (d) => { setFaultResult(d); setFaultError(null); qc.invalidateQueries({ queryKey: ['twin'] }) },
    onError: (e: Error) => { setFaultError(e); setFaultResult(null) },
  })

  const restoreMut = useMutation({
    mutationFn: ({ scenario, needsCell }: { scenario: string; needsCell: boolean }) =>
      twinApi.restoreFault(scenario, needsCell ? restoreParams(scenario, faultCell) : {}),
    onSuccess: (d) => { setFaultResult(d); setFaultError(null); qc.invalidateQueries({ queryKey: ['twin'] }) },
    onError: (e: Error) => { setFaultError(e); setFaultResult(null) },
  })

  const agentFaultMut = useMutation({
    mutationFn: () => twinApi.injectAgentFault('evening_congestion'),
    onSuccess: (d) => { setFaultResult(d); setFaultError(null) },
    onError: (e: Error) => { setFaultError(e); setFaultResult(null) },
  })

  // Handover tuning form
  const [hoCell, setHoCell]     = useState('')
  const [hoA3,   setHoA3]       = useState('')
  const [hoTtt,  setHoTtt]      = useState('')
  const [hoResult, setHoResult] = useState<unknown>(null)
  const [hoError,  setHoError]  = useState<Error | null>(null)
  const hoMut = useMutation({
    mutationFn: () => twinApi.tuneHandover(
      hoCell || activeCell,
      hoA3  ? parseFloat(hoA3)  : undefined,
      hoTtt ? parseFloat(hoTtt) : undefined,
    ),
    onSuccess: (d) => { setHoResult(d); setHoError(null) },
    onError: (e: Error) => { setHoError(e); setHoResult(null) },
  })

  // Energy mode form
  const [emCell, setEmCell]     = useState('')
  const [emMode, setEmMode]     = useState('ACTIVE')
  const [emResult, setEmResult] = useState<unknown>(null)
  const [emError,  setEmError]  = useState<Error | null>(null)
  const emMut = useMutation({
    mutationFn: () => twinApi.enableEnergySaving(emCell || activeCell, emMode),
    onSuccess: (d) => { setEmResult(d); setEmError(null) },
    onError: (e: Error) => { setEmError(e); setEmResult(null) },
  })

  // Slice policy form (direct to twin, no incident_id needed)
  const [spSlice,  setSpSlice]  = useState('slice-premium')
  const [spMin,    setSpMin]    = useState('')
  const [spMax,    setSpMax]    = useState('')
  const [spPrio,   setSpPrio]   = useState('')
  const [spResult, setSpResult] = useState<unknown>(null)
  const [spError,  setSpError]  = useState<Error | null>(null)
  const spMut = useMutation({
    mutationFn: () => twinApi.applySlicePolicy(
      spSlice,
      spMin  ? parseFloat(spMin)  : undefined,
      spMax  ? parseFloat(spMax)  : undefined,
      spPrio ? parseInt(spPrio)   : undefined,
    ),
    onSuccess: (d) => { setSpResult(d); setSpError(null) },
    onError: (e: Error) => { setSpError(e); setSpResult(null) },
  })

  const cellHistory = cellQ.data?.kpis ?? []

  return (
    <div className="space-y-6">

      {/* Sim status */}
      {health.data && (
        <div className="flex flex-wrap gap-4 text-sm text-gray-600 bg-white rounded-xl px-5 py-3 shadow-sm border border-gray-100">
          <span><span className="font-semibold text-gray-800">Tick</span> {health.data.tick}</span>
          <span><span className="font-semibold text-gray-800">Sim time</span> T+{Math.floor(health.data.sim_time_s / 60)}m {health.data.sim_time_s % 60}s</span>
          <span><span className="font-semibold text-gray-800">Cells</span> {health.data.cells}</span>
          <span><span className="font-semibold text-gray-800">Kafka</span> {health.data.kafka}</span>
          <span><span className="font-semibold text-gray-800">InfluxDB</span> {health.data.influxdb}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Cell KPI Detail */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-800">Cell KPI Detail</h2>
            <select
              value={activeCell}
              onChange={e => setSelectedCell(e.target.value)}
              className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {cells.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          {cellQ.isLoading && <div className="text-gray-400 text-sm">Loading…</div>}
          {cellQ.isError  && <div className="text-red-500 text-sm">Error loading cell data</div>}

          {cellHistory.length > 0 && (() => {
            const latest = cellHistory[cellHistory.length - 1]
            return (
              <div className="grid grid-cols-2 gap-3 mb-4">
                {[
                  { label: 'PRB Util',    value: `${fmt(latest.prb_util)}%`,           warn: latest.prb_util > 80 },
                  { label: 'Throughput',  value: `${fmt(latest.throughput_mbps)} Mbps`, warn: false },
                  { label: 'SINR',        value: `${fmt(latest.sinr_db)} dB`,           warn: latest.sinr_db < 5 },
                  { label: 'Latency P95', value: `${fmt(latest.latency_p95_ms)} ms`,    warn: latest.latency_p95_ms > 100 },
                  { label: 'Pkt Loss',    value: `${fmt(latest.packet_loss_pct, 2)}%`,  warn: latest.packet_loss_pct > 1 },
                  { label: 'HO Fail',     value: `${fmt(latest.ho_fail_rate * 100)}%`,  warn: latest.ho_fail_rate > 0.05 },
                ].map(({ label, value, warn }) => (
                  <div key={label} className={`rounded-lg p-3 ${warn ? 'bg-red-50' : 'bg-gray-50'}`}>
                    <div className="text-xs text-gray-500">{label}</div>
                    <div className={`text-lg font-bold ${warn ? 'text-red-700' : 'text-gray-800'}`}>{value}</div>
                  </div>
                ))}
              </div>
            )
          })()}

          {/* PRB history bars */}
          {cellHistory.length > 1 && (
            <div>
              <div className="text-xs text-gray-500 mb-2 uppercase tracking-wider">PRB Utilization History</div>
              <div className="flex items-end gap-0.5 h-16">
                {cellHistory.slice(-20).map((k, i) => (
                  <div
                    key={i}
                    className={`flex-1 rounded-sm transition-all ${k.prb_util > 80 ? 'bg-red-400' : k.prb_util > 60 ? 'bg-amber-400' : 'bg-blue-400'}`}
                    style={{ height: `${Math.max(4, k.prb_util)}%` }}
                    title={`${fmt(k.prb_util)}% @ ${new Date(k.ts).toLocaleTimeString()}`}
                  />
                ))}
              </div>
              <div className="flex justify-between text-xs text-gray-400 mt-1">
                <span>oldest</span><span>latest</span>
              </div>
            </div>
          )}
        </div>

        {/* Recent events */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <h2 className="font-semibold text-gray-800 mb-4">Network Events</h2>
          <div className="space-y-1.5 max-h-80 overflow-y-auto">
            {(eventsQ.data?.events ?? []).length === 0 && (
              <div className="text-sm text-gray-400">No events yet</div>
            )}
            {(eventsQ.data?.events ?? []).map(ev => (
              <div key={ev.event_id} className="flex items-center gap-2 text-sm py-1.5 border-b border-gray-50">
                <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded text-gray-600">{ev.event_type}</span>
                <span className="text-gray-700 font-medium">{ev.entity_id}</span>
                <span className="ml-auto text-xs text-gray-400">{ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : ''}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Fault Injection */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <h2 className="font-semibold text-gray-800 mb-1">Fault Injection</h2>
        <p className="text-xs text-gray-500 mb-4">
          Inject synthetic faults into the Digital Twin simulation.
          Cell-specific scenarios (Backhaul, Mobility Storm, Energy Saving Failure) use the cell below.
        </p>

        {/* Cell selector for cell-specific faults */}
        <div className="flex items-center gap-3 mb-4">
          <label className="text-xs text-gray-500 shrink-0">Target cell for cell-specific faults:</label>
          <select
            value={faultCell}
            onChange={e => setFaultCell(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {cells.length > 0
              ? cells.map(c => <option key={c} value={c}>{c}</option>)
              : ['C00','C01','C10','C11','C20'].map(c => <option key={c} value={c}>{c}</option>)
            }
          </select>
        </div>

        <div className="flex flex-wrap gap-3 mb-4">
          {FAULT_SCENARIOS.map(s => (
            <button
              key={s.id}
              onClick={() => faultMut.mutate({ scenario: s.id, needsCell: s.needsCell })}
              disabled={faultMut.isPending}
              className={`px-4 py-2 text-sm text-white rounded-lg font-medium transition-all disabled:opacity-50 ${s.color}`}
            >
              {s.label}{s.needsCell ? ` (${faultCell})` : ''}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-3 mb-4">
          {RESTORE_SCENARIOS.map(s => (
            <button
              key={s.id}
              onClick={() => restoreMut.mutate({ scenario: s.id, needsCell: s.needsCell })}
              disabled={restoreMut.isPending}
              className="px-4 py-2 text-sm text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium transition-all disabled:opacity-50"
            >
              ↩ {s.label}{s.needsCell ? ` (${faultCell})` : ''}
            </button>
          ))}
        </div>

        <button
          onClick={() => agentFaultMut.mutate()}
          disabled={agentFaultMut.isPending}
          className="px-4 py-2 text-sm text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg font-medium transition-all disabled:opacity-50"
        >
          {agentFaultMut.isPending ? 'Triggering…' : '🤖 Inject Fault + Trigger AI Pipeline'}
        </button>

        <ActionResult result={faultResult} error={faultError} />
        {agentFaultMut.data && (
          <div className="mt-2 p-2 bg-indigo-50 border border-indigo-200 rounded text-xs text-indigo-700 font-mono">
            {JSON.stringify(agentFaultMut.data, null, 2)}
          </div>
        )}
      </div>

      {/* Manual Actions */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

        {/* Handover tuning (direct to twin) */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <h3 className="font-semibold text-gray-800 mb-1">Tune Handover</h3>
          <p className="text-xs text-gray-400 mb-3">Direct twin call — no audit trail</p>
          <div className="space-y-2">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Cell ID</label>
              <select
                value={hoCell || activeCell}
                onChange={e => setHoCell(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {cells.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-500 block mb-1">A3 Offset (dB)</label>
                <input
                  value={hoA3}
                  onChange={e => setHoA3(e.target.value)}
                  placeholder="e.g. 3.0"
                  type="number"
                  step="0.1"
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">TTT (ms)</label>
                <input
                  value={hoTtt}
                  onChange={e => setHoTtt(e.target.value)}
                  placeholder="e.g. 40"
                  type="number"
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <button
              onClick={() => hoMut.mutate()}
              disabled={hoMut.isPending}
              className="w-full py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-all disabled:opacity-50"
            >
              {hoMut.isPending ? 'Applying…' : 'Apply'}
            </button>
            <ActionResult result={hoResult} error={hoError} />
          </div>
        </div>

        {/* Energy mode (direct to twin) */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <h3 className="font-semibold text-gray-800 mb-1">Energy Mode</h3>
          <p className="text-xs text-gray-400 mb-3">Direct twin call — no audit trail</p>
          <div className="space-y-2">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Cell ID</label>
              <select
                value={emCell || activeCell}
                onChange={e => setEmCell(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {cells.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Mode</label>
              <select
                value={emMode}
                onChange={e => setEmMode(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {ENERGY_MODES.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <button
              onClick={() => emMut.mutate()}
              disabled={emMut.isPending}
              className="w-full py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-all disabled:opacity-50"
            >
              {emMut.isPending ? 'Applying…' : 'Set Energy Mode'}
            </button>
            <ActionResult result={emResult} error={emError} />
          </div>
        </div>

        {/* Slice policy (direct to twin) */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <h3 className="font-semibold text-gray-800 mb-1">Slice Policy</h3>
          <p className="text-xs text-gray-400 mb-3">Direct twin call — no audit trail</p>
          <div className="space-y-2">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Slice ID</label>
              <select
                value={spSlice}
                onChange={e => setSpSlice(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {SLICE_IDS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-500 block mb-1">Min BW%</label>
                <input value={spMin} onChange={e => setSpMin(e.target.value)} type="number" placeholder="0"
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Max BW%</label>
                <input value={spMax} onChange={e => setSpMax(e.target.value)} type="number" placeholder="80"
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Priority (1=highest)</label>
              <input value={spPrio} onChange={e => setSpPrio(e.target.value)} type="number" placeholder="1"
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <button
              onClick={() => spMut.mutate()}
              disabled={spMut.isPending}
              className="w-full py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-all disabled:opacity-50"
            >
              {spMut.isPending ? 'Applying…' : 'Apply Policy'}
            </button>
            <ActionResult result={spResult} error={spError} />
          </div>
        </div>
      </div>
    </div>
  )
}
