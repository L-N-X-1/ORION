import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { actuatorApi } from '../api/actuator'
import { twinApi } from '../api/digitalTwin'
import { POLL_SLOW, POLL_FAST } from '../config'

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

export default function Actuator() {
  const health   = useQuery({ queryKey: ['act', 'health'],   queryFn: actuatorApi.health,   refetchInterval: POLL_SLOW, retry: 1 })
  const metrics  = useQuery({ queryKey: ['twin', 'metrics'], queryFn: twinApi.metrics,       refetchInterval: POLL_FAST })
  const snapshot = useQuery({ queryKey: ['twin', 'snapshot'], queryFn: twinApi.snapshot,     refetchInterval: 15_000 })

  const cells = metrics.data?.kpis.map(k => k.cell_id) ?? []

  // Rollback form
  const [rbIncident, setRbIncident] = useState('')
  const [rbChange,   setRbChange]   = useState('')
  const [rbResult,   setRbResult]   = useState<unknown>(null)
  const [rbError,    setRbError]    = useState<Error | null>(null)
  const rbMut = useMutation({
    mutationFn: () => actuatorApi.rollback(rbIncident, rbChange),
    onSuccess: (d) => { setRbResult(d); setRbError(null) },
    onError:   (e: Error) => { setRbError(e); setRbResult(null) },
  })

  // Also twin direct rollback (no incident_id needed)
  const [twinRbChange, setTwinRbChange] = useState('')
  const [twinRbResult, setTwinRbResult] = useState<unknown>(null)
  const [twinRbError,  setTwinRbError]  = useState<Error | null>(null)
  const twinRbMut = useMutation({
    mutationFn: (changeId: string) => twinApi.rollback(changeId),
    onSuccess: (d) => { setTwinRbResult(d); setTwinRbError(null) },
    onError:   (e: Error) => { setTwinRbError(e); setTwinRbResult(null) },
  })

  // Slice policy via actuator
  const [spIncident, setSpIncident] = useState('INC-MANUAL')
  const [spSlice,    setSpSlice]    = useState('slice-premium')
  const [spMin,      setSpMin]      = useState('')
  const [spMax,      setSpMax]      = useState('')
  const [spPrio,     setSpPrio]     = useState('')
  const [spResult,   setSpResult]   = useState<unknown>(null)
  const [spError,    setSpError]    = useState<Error | null>(null)
  const spMut = useMutation({
    mutationFn: () => actuatorApi.applySlicePolicy(spIncident, spSlice,
      spMin ? parseFloat(spMin) : undefined,
      spMax ? parseFloat(spMax) : undefined,
      spPrio ? parseInt(spPrio) : undefined,
    ),
    onSuccess: (d) => { setSpResult(d); setSpError(null) },
    onError:   (e: Error) => { setSpError(e); setSpResult(null) },
  })

  // Handover via actuator
  const [hoIncident, setHoIncident] = useState('INC-MANUAL')
  const [hoCell,     setHoCell]     = useState('')
  const [hoA3,       setHoA3]       = useState('')
  const [hoTtt,      setHoTtt]      = useState('')
  const [hoResult,   setHoResult]   = useState<unknown>(null)
  const [hoError,    setHoError]    = useState<Error | null>(null)
  const hoMut = useMutation({
    mutationFn: () => actuatorApi.tuneHandover(hoIncident, hoCell || cells[0] || 'C00',
      hoA3 ? parseFloat(hoA3) : undefined,
      hoTtt ? parseFloat(hoTtt) : undefined,
    ),
    onSuccess: (d) => { setHoResult(d); setHoError(null) },
    onError:   (e: Error) => { setHoError(e); setHoResult(null) },
  })

  // Energy mode via actuator
  const [emIncident, setEmIncident] = useState('INC-MANUAL')
  const [emCell,     setEmCell]     = useState('')
  const [emMode,     setEmMode]     = useState('ACTIVE')
  const [emResult,   setEmResult]   = useState<unknown>(null)
  const [emError,    setEmError]    = useState<Error | null>(null)
  const emMut = useMutation({
    mutationFn: () => actuatorApi.enableEnergySaving(emIncident, emCell || cells[0] || 'C00', emMode),
    onSuccess: (d) => { setEmResult(d); setEmError(null) },
    onError:   (e: Error) => { setEmError(e); setEmResult(null) },
  })

  // Change records from snapshot
  const changeRecords = (snapshot.data?.change_records as Record<string, unknown> | undefined) ?? {}
  const changeEntries = Object.entries(changeRecords)

  const isOnline = health.data?.status === 'ok'

  return (
    <div className="space-y-6">

      {/* Health */}
      <div className={`rounded-xl p-4 border-2 ${isOnline ? 'border-emerald-400 bg-emerald-50' : health.isError ? 'border-red-400 bg-red-50' : 'border-gray-200 bg-white'}`}>
        <div className="flex items-center gap-2">
          <span className={`w-3 h-3 rounded-full ${isOnline ? 'bg-emerald-500 animate-pulse' : health.isError ? 'bg-red-500' : 'bg-gray-300'}`} />
          <span className="font-semibold text-gray-800">Actuator Service</span>
          <span className="ml-auto text-sm text-gray-500">
            {health.isLoading ? 'Checking…' : isOnline ? 'Online — applies changes to Digital Twin + records to PostgreSQL' : 'Offline'}
          </span>
        </div>
      </div>

      {/* Rollback */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <h3 className="font-semibold text-gray-800 mb-1">Rollback via Actuator</h3>
          <p className="text-xs text-gray-500 mb-3">Looks up change record in PostgreSQL and calls twin /rollback</p>
          <div className="space-y-2">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Incident ID</label>
              <input value={rbIncident} onChange={e => setRbIncident(e.target.value)} placeholder="INC-xxxxxxxx"
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Change ID</label>
              <input value={rbChange} onChange={e => setRbChange(e.target.value)} placeholder="CHG-xxxxxxxx"
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <button onClick={() => rbMut.mutate()} disabled={!rbChange || rbMut.isPending || !isOnline}
              className="w-full py-2 text-sm text-white bg-amber-600 hover:bg-amber-700 rounded-lg font-medium transition-all disabled:opacity-50">
              ↩ Rollback
            </button>
            <ActionResult result={rbResult} error={rbError} />
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <h3 className="font-semibold text-gray-800 mb-1">Direct Twin Rollback</h3>
          <p className="text-xs text-gray-500 mb-3">Directly rollback a change by ID from the twin's in-memory records</p>
          <div className="space-y-2">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Change ID (from twin)</label>
              <input value={twinRbChange} onChange={e => setTwinRbChange(e.target.value)} placeholder="CHG-xxxxxx"
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <button onClick={() => twinRbMut.mutate(twinRbChange)} disabled={!twinRbChange || twinRbMut.isPending}
              className="w-full py-2 text-sm text-white bg-amber-600 hover:bg-amber-700 rounded-lg font-medium transition-all disabled:opacity-50">
              ↩ Rollback
            </button>
            <ActionResult result={twinRbResult} error={twinRbError} />
          </div>
        </div>
      </div>

      {/* In-flight change records */}
      {changeEntries.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <h2 className="font-semibold text-gray-800 mb-3">Active Change Records (Digital Twin)</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs text-gray-500 uppercase tracking-wider">
                  <th className="px-3 py-2 text-left">Change ID</th>
                  <th className="px-3 py-2 text-left">Type</th>
                  <th className="px-3 py-2 text-left">Target</th>
                  <th className="px-3 py-2 text-right">Sim Time</th>
                  <th className="px-3 py-2 text-center">Rollback</th>
                </tr>
              </thead>
              <tbody>
                {changeEntries.map(([id, rec]) => {
                  const r = rec as Record<string, unknown>
                  return (
                    <tr key={id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-3 py-2 font-mono text-xs text-blue-600">{id}</td>
                      <td className="px-3 py-2 text-gray-700">{String(r.type ?? '—')}</td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-600">
                        {String(r.cell_id ?? r.slice_id ?? '—')}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-gray-500">
                        T+{Number(r.sim_time_s ?? 0).toFixed(0)}s
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          onClick={() => twinRbMut.mutate(id)}
                          className="text-xs px-2 py-1 bg-amber-100 text-amber-800 hover:bg-amber-200 rounded font-medium transition-colors"
                        >
                          ↩
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Manual actions via actuator */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

        {/* Slice policy */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <h3 className="font-semibold text-gray-800 mb-3">Slice Policy (via Actuator)</h3>
          <div className="space-y-2">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Incident ID</label>
              <input value={spIncident} onChange={e => setSpIncident(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Slice ID</label>
              <select value={spSlice} onChange={e => setSpSlice(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="slice-premium">slice-premium</option>
                <option value="slice-standard">slice-standard</option>
                <option value="slice-iot">slice-iot</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-500 block mb-1">Min BW%</label>
                <input value={spMin} onChange={e => setSpMin(e.target.value)} type="number"
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Max BW%</label>
                <input value={spMax} onChange={e => setSpMax(e.target.value)} type="number"
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            <button onClick={() => spMut.mutate()} disabled={spMut.isPending || !isOnline}
              className="w-full py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-all disabled:opacity-50">
              {spMut.isPending ? 'Applying…' : 'Apply + Record to DB'}
            </button>
            <ActionResult result={spResult} error={spError} />
          </div>
        </div>

        {/* Handover */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <h3 className="font-semibold text-gray-800 mb-3">Tune Handover (via Actuator)</h3>
          <div className="space-y-2">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Incident ID</label>
              <input value={hoIncident} onChange={e => setHoIncident(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Cell ID</label>
              <select value={hoCell} onChange={e => setHoCell(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">— select —</option>
                {cells.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-500 block mb-1">A3 Offset</label>
                <input value={hoA3} onChange={e => setHoA3(e.target.value)} type="number" placeholder="3.0"
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">TTT (ms)</label>
                <input value={hoTtt} onChange={e => setHoTtt(e.target.value)} type="number" placeholder="40"
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            <button onClick={() => hoMut.mutate()} disabled={hoMut.isPending || !isOnline}
              className="w-full py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-all disabled:opacity-50">
              {hoMut.isPending ? 'Applying…' : 'Apply + Record to DB'}
            </button>
            <ActionResult result={hoResult} error={hoError} />
          </div>
        </div>

        {/* Energy mode */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <h3 className="font-semibold text-gray-800 mb-3">Energy Mode (via Actuator)</h3>
          <div className="space-y-2">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Incident ID</label>
              <input value={emIncident} onChange={e => setEmIncident(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Cell ID</label>
              <select value={emCell} onChange={e => setEmCell(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">— select —</option>
                {cells.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Mode</label>
              <select value={emMode} onChange={e => setEmMode(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="ACTIVE">ACTIVE</option>
                <option value="SLEEP">SLEEP</option>
                <option value="SHUTDOWN">SHUTDOWN</option>
              </select>
            </div>
            <button onClick={() => emMut.mutate()} disabled={emMut.isPending || !isOnline}
              className="w-full py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-all disabled:opacity-50">
              {emMut.isPending ? 'Applying…' : 'Set Mode + Record to DB'}
            </button>
            <ActionResult result={emResult} error={emError} />
          </div>
        </div>
      </div>
    </div>
  )
}
