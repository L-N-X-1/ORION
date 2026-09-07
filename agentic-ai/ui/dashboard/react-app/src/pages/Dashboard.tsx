import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { twinApi, type CellKPI } from '../api/digitalTwin'
import { actuatorApi } from '../api/actuator'
import { agentApi } from '../api/aiAgent'
import { POLL_FAST, POLL_SLOW } from '../config'

function fmt(n: number, dp = 1) { return n.toFixed(dp) }

function prbTextColor(v: number) {
  if (v > 80) return 'text-red-600 font-bold'
  if (v > 60) return 'text-amber-600 font-semibold'
  return 'text-emerald-700 dark:text-emerald-400'
}

function prbBarColor(v: number) {
  if (v > 80) return 'bg-red-500'
  if (v > 60) return 'bg-amber-400'
  return 'bg-blue-400'
}

function energyBadge(mode: string) {
  const cls = mode === 'ACTIVE' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300'
    : mode === 'SLEEP' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300'
    : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300'
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{mode}</span>
}

function ServiceCard({ label, ok, detail }: { label: string; ok: boolean | null; detail?: string }) {
  const ring = ok === null ? 'border-gray-200 dark:border-gray-700' : ok ? 'border-emerald-400' : 'border-red-400'
  const dot  = ok === null ? 'bg-gray-300 dark:bg-gray-600' : ok ? 'bg-emerald-400 animate-pulse' : 'bg-red-500'
  return (
    <div className={`bg-white dark:bg-gray-800 rounded-xl p-4 border-2 ${ring} shadow-sm`}>
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2.5 h-2.5 rounded-full ${dot}`} />
        <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">{label}</span>
      </div>
      <div className="text-xs text-gray-400 dark:text-gray-500">{detail ?? (ok === null ? 'Checking…' : ok ? 'Online' : 'Offline')}</div>
    </div>
  )
}

function StatCard({ label, value, sub, color = 'text-gray-900 dark:text-white' }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-100 dark:border-gray-700">
      <div className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-3xl font-bold ${color}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{sub}</div>}
    </div>
  )
}

// ── Color palette for up to 12 cells ────────────────────────────────────────
const PALETTE = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b',
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16',
  '#f97316', '#6366f1', '#14b8a6', '#f43f5e',
]

// ── Multi-line sparkline (one line per cell) ─────────────────────────────────
function MultiLineSparkline({
  data,       // cellId → values[]
  allCells,   // ordered list for consistent color assignment
  maxVal,
}: {
  data: Record<string, number[]>
  allCells: string[]
  maxVal: number
}) {
  const W = 200, H = 48
  const entries = Object.entries(data).filter(([, v]) => v.length >= 2)
  if (entries.length === 0) {
    return <div className="h-12 flex items-center justify-center text-xs text-gray-300 dark:text-gray-600">Collecting…</div>
  }
  const maxLen = Math.max(...entries.map(([, v]) => v.length))
  const safe   = Math.max(maxVal, 0.01)
  const step   = W / Math.max(maxLen - 1, 1)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height: '48px' }}>
      {entries.map(([cellId, values]) => {
        const colorIdx = allCells.indexOf(cellId)
        const color    = PALETTE[colorIdx >= 0 ? colorIdx % PALETTE.length : 0]
        const startX   = (maxLen - values.length) * step
        const pts = values.map((v, i) => {
          const x = startX + i * step
          const y = H - (Math.min(Math.max(v, 0), safe) / safe) * (H - 6) - 3
          return `${x.toFixed(1)},${y.toFixed(1)}`
        })
        return (
          <path
            key={cellId}
            d={`M${pts.join(' L')}`}
            fill="none"
            stroke={color}
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity="0.85"
          />
        )
      })}
    </svg>
  )
}

// Single-line sparkline for SLA count (aggregate)
function Sparkline({ values, maxVal, color = '#3b82f6' }: { values: number[]; maxVal: number; color?: string }) {
  const W = 200, H = 48
  if (values.length < 2) {
    return <div className="h-12 flex items-center justify-center text-xs text-gray-300 dark:text-gray-600">Collecting…</div>
  }
  const safe = Math.max(maxVal, 0.01)
  const step = W / (values.length - 1)
  const pts  = values.map((v, i) => {
    const x = i * step
    const y = H - (Math.min(Math.max(v, 0), safe) / safe) * (H - 6) - 3
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const lineD = `M${pts.join(' L')}`
  const fillD = `${lineD} L${W},${H} L0,${H} Z`
  const gradId = `sg-${color.replace(/[^a-z0-9]/gi, '')}`
  const last = pts[pts.length - 1].split(',')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height: '48px' }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.2" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fillD} fill={`url(#${gradId})`} />
      <path d={lineD} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={parseFloat(last[0])} cy={parseFloat(last[1])} r="2.5" fill={color} />
    </svg>
  )
}

// Cell color legend
function CellLegend({ allCells }: { allCells: string[] }) {
  if (allCells.length === 0) return null
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
      {allCells.map((cellId, i) => (
        <span key={cellId} className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: PALETTE[i % PALETTE.length] }} />
          {cellId}
        </span>
      ))}
    </div>
  )
}

// Per-cell KPI history type
interface KpiCellHist {
  prb:     Record<string, number[]>
  tput:    Record<string, number[]>
  latency: Record<string, number[]>
  sinr:    Record<string, number[]>
  hoFail:  Record<string, number[]>
  pktLoss: Record<string, number[]>
  slaCount: number[]
}

const emptyHist = (): KpiCellHist => ({
  prb: {}, tput: {}, latency: {}, sinr: {}, hoFail: {}, pktLoss: {}, slaCount: [],
})

function maxOfRecord(rec: Record<string, number[]>, fallback: number) {
  const vals = Object.values(rec).flat()
  return vals.length ? Math.max(fallback, ...vals) : fallback
}

export default function Dashboard() {
  const health      = useQuery({ queryKey: ['twin', 'health'],   queryFn: twinApi.health,           refetchInterval: POLL_SLOW })
  const metrics     = useQuery({ queryKey: ['twin', 'metrics'],  queryFn: twinApi.metrics,           refetchInterval: POLL_FAST })
  const events      = useQuery({ queryKey: ['twin', 'events'],   queryFn: () => twinApi.events(30),  refetchInterval: POLL_FAST })
  const actHealth   = useQuery({ queryKey: ['act',  'health'],   queryFn: actuatorApi.health,        refetchInterval: POLL_SLOW, retry: 1 })
  const agentHealth = useQuery({ queryKey: ['agent','health'],   queryFn: agentApi.health,           refetchInterval: POLL_SLOW, retry: 1 })

  const kpis: CellKPI[] = metrics.data?.kpis ?? []
  const slaCount = kpis.filter(k => k.sla_violation).length
  const avgPrb   = kpis.length ? kpis.reduce((s, k) => s + k.prb_util,         0) / kpis.length : 0
  const avgTput  = kpis.length ? kpis.reduce((s, k) => s + k.throughput_mbps,  0) / kpis.length : 0
  const avgLat   = kpis.length ? kpis.reduce((s, k) => s + k.latency_p95_ms,   0) / kpis.length : 0

  const [kpiHist, setKpiHist] = useState<KpiCellHist>(emptyHist)

  useEffect(() => {
    if (!metrics.data || metrics.data.kpis.length === 0) return
    setKpiHist(prev => {
      const prb     = { ...prev.prb }
      const tput    = { ...prev.tput }
      const latency = { ...prev.latency }
      const sinr    = { ...prev.sinr }
      const hoFail  = { ...prev.hoFail }
      const pktLoss = { ...prev.pktLoss }
      for (const k of metrics.data!.kpis) {
        const id = k.cell_id
        prb[id]     = [...(prev.prb[id]     ?? []).slice(-60), k.prb_util]
        tput[id]    = [...(prev.tput[id]    ?? []).slice(-60), k.throughput_mbps]
        latency[id] = [...(prev.latency[id] ?? []).slice(-60), k.latency_p95_ms]
        sinr[id]    = [...(prev.sinr[id]    ?? []).slice(-60), k.sinr_db]
        hoFail[id]  = [...(prev.hoFail[id]  ?? []).slice(-60), k.ho_fail_rate * 100]
        pktLoss[id] = [...(prev.pktLoss[id] ?? []).slice(-60), k.packet_loss_pct]
      }
      const sc = metrics.data!.kpis.filter(k => k.sla_violation).length
      return {
        prb, tput, latency, sinr, hoFail, pktLoss,
        slaCount: [...prev.slaCount.slice(-60), sc],
      }
    })
  }, [metrics.data])

  const allCells = useMemo(() => Object.keys(kpiHist.prb).sort(), [kpiHist.prb])
  const sortedCells = [...kpis].sort((a, b) => b.prb_util - a.prb_util)

  const maxTput    = maxOfRecord(kpiHist.tput,    100)
  const maxLat     = maxOfRecord(kpiHist.latency, 200)
  const maxSinr    = maxOfRecord(kpiHist.sinr,     40)
  const maxHoFail  = maxOfRecord(kpiHist.hoFail,   10)
  const maxPktLoss = maxOfRecord(kpiHist.pktLoss,   5)
  const maxSla     = Math.max(kpis.length || 1, ...(kpiHist.slaCount.length ? kpiHist.slaCount : [0]))

  return (
    <div className="space-y-6">

      {/* Service health */}
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-3">Service Health</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <ServiceCard
            label="Digital Twin"
            ok={health.isError ? false : health.data ? true : null}
            detail={health.data ? `Tick ${health.data.tick} · ${health.data.cells} cells` : undefined}
          />
          <ServiceCard label="Actuator" ok={actHealth.isError ? false : actHealth.data ? true : null} />
          <ServiceCard
            label="AI Agent"
            ok={agentHealth.isError ? false : agentHealth.data?.status === 'ok' ? true : agentHealth.isLoading ? null : false}
          />
          <ServiceCard label="Collector" ok={null} detail="No health endpoint exposed" />
        </div>
      </div>

      {/* KPI summary */}
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-3">KPI Summary</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Avg PRB Util"   value={`${fmt(avgPrb)}%`}     color={avgPrb > 80 ? 'text-red-600' : 'text-gray-900 dark:text-white'} />
          <StatCard label="Avg Throughput" value={`${fmt(avgTput)} Mbps`} />
          <StatCard label="SLA Violations" value={slaCount}               color={slaCount > 0 ? 'text-red-600' : 'text-emerald-700 dark:text-emerald-400'} />
          <StatCard
            label="Sim Time"
            value={health.data ? `T+${Math.floor(health.data.sim_time_s / 60)}m` : '—'}
            sub={health.data ? `Tick ${health.data.tick}` : undefined}
          />
        </div>
      </div>

      {/* KPI Charts */}
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-3">KPI Charts — Per Cell</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* PRB by cell bar chart */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-5">
            <div className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">PRB Utilization by Cell (live, sorted)</div>
            {sortedCells.length === 0 ? (
              <div className="text-xs text-gray-400 dark:text-gray-500 text-center py-6">Waiting for data…</div>
            ) : (
              <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                {sortedCells.map(k => (
                  <div key={k.cell_id} className="flex items-center gap-2 text-xs">
                    <span className="w-7 font-mono text-gray-500 dark:text-gray-400 shrink-0">{k.cell_id}</span>
                    <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-3 overflow-hidden">
                      <div
                        className={`h-3 rounded-full transition-all duration-500 ${prbBarColor(k.prb_util)}`}
                        style={{ width: `${Math.min(100, k.prb_util)}%` }}
                      />
                    </div>
                    <span className={`w-12 text-right font-mono shrink-0 ${k.prb_util > 80 ? 'text-red-600 font-bold' : k.prb_util > 60 ? 'text-amber-600' : 'text-gray-600 dark:text-gray-400'}`}>
                      {fmt(k.prb_util)}%
                    </span>
                    {k.sla_violation && <span className="text-red-500 shrink-0" title="SLA breach">⚠</span>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* KPI time-series — per-cell multi-line sparklines */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-5">
            <div className="flex items-start justify-between mb-3">
              <div className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                KPI Trends — Per Cell
              </div>
              <span className="text-xs text-gray-400 dark:text-gray-500">5 s interval</span>
            </div>
            <CellLegend allCells={allCells} />
            <div className="space-y-4 mt-4">

              {/* PRB */}
              <div>
                <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
                  <span>PRB Utilization (%)</span>
                  <span className={avgPrb > 80 ? 'text-red-600 font-bold' : 'text-gray-700 dark:text-gray-300'}>{fmt(avgPrb)}% avg</span>
                </div>
                <MultiLineSparkline data={kpiHist.prb} allCells={allCells} maxVal={100} />
              </div>

              {/* Throughput */}
              <div>
                <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
                  <span>Throughput (Mbps)</span>
                  <span className="text-gray-700 dark:text-gray-300">{fmt(avgTput)} avg</span>
                </div>
                <MultiLineSparkline data={kpiHist.tput} allCells={allCells} maxVal={maxTput} />
              </div>

              {/* Latency */}
              <div>
                <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
                  <span>Latency P95 (ms)</span>
                  <span className={avgLat > 100 ? 'text-amber-600 font-bold' : 'text-gray-700 dark:text-gray-300'}>{fmt(avgLat)} avg</span>
                </div>
                <MultiLineSparkline data={kpiHist.latency} allCells={allCells} maxVal={maxLat} />
              </div>

              {/* SINR */}
              <div>
                <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
                  <span>SINR (dB)</span>
                </div>
                <MultiLineSparkline data={kpiHist.sinr} allCells={allCells} maxVal={maxSinr} />
              </div>

              {/* HO Fail Rate */}
              <div>
                <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
                  <span>HO Fail Rate (%)</span>
                </div>
                <MultiLineSparkline data={kpiHist.hoFail} allCells={allCells} maxVal={maxHoFail} />
              </div>

              {/* Packet Loss */}
              <div>
                <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
                  <span>Packet Loss (%)</span>
                </div>
                <MultiLineSparkline data={kpiHist.pktLoss} allCells={allCells} maxVal={maxPktLoss} />
              </div>

              {/* SLA violations count (aggregate) */}
              <div>
                <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
                  <span>SLA Violations (count)</span>
                  <span className={slaCount > 0 ? 'text-red-600 font-bold' : 'text-emerald-600 dark:text-emerald-400'}>{slaCount}</span>
                </div>
                <Sparkline values={kpiHist.slaCount} maxVal={maxSla} color="#f59e0b" />
              </div>

            </div>
          </div>
        </div>
      </div>

      {/* Cell KPI table */}
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-3">Cell KPIs — Live</h2>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-x-auto">
          {metrics.isLoading && <div className="p-8 text-center text-gray-400 dark:text-gray-500">Loading KPIs…</div>}
          {metrics.isError && (
            <div className="p-6 text-center text-red-500 text-sm">
              Cannot reach Digital Twin service. Is it running?
            </div>
          )}
          {kpis.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  <th className="px-4 py-3 text-left">Cell</th>
                  <th className="px-4 py-3 text-right">PRB%</th>
                  <th className="px-4 py-3 text-right">Tput (Mbps)</th>
                  <th className="px-4 py-3 text-right">SINR (dB)</th>
                  <th className="px-4 py-3 text-right">Lat P95 (ms)</th>
                  <th className="px-4 py-3 text-right">HO Fail</th>
                  <th className="px-4 py-3 text-right">Pkt Loss%</th>
                  <th className="px-4 py-3 text-center">Energy</th>
                  <th className="px-4 py-3 text-center">SLA</th>
                </tr>
              </thead>
              <tbody>
                {kpis.map((k) => (
                  <tr key={k.cell_id} className={`border-b border-gray-50 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${k.sla_violation ? 'bg-red-50 dark:bg-red-950' : ''}`}>
                    <td className="px-4 py-2.5 font-mono font-semibold text-gray-800 dark:text-gray-200">{k.cell_id}</td>
                    <td className={`px-4 py-2.5 text-right font-mono ${prbTextColor(k.prb_util)}`}>{fmt(k.prb_util)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-gray-700 dark:text-gray-300">{fmt(k.throughput_mbps)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-gray-700 dark:text-gray-300">{fmt(k.sinr_db)}</td>
                    <td className={`px-4 py-2.5 text-right font-mono ${k.latency_p95_ms > 100 ? 'text-amber-600 font-semibold' : 'text-gray-700 dark:text-gray-300'}`}>
                      {fmt(k.latency_p95_ms)}
                    </td>
                    <td className={`px-4 py-2.5 text-right font-mono ${k.ho_fail_rate > 0.1 ? 'text-red-600' : 'text-gray-700 dark:text-gray-300'}`}>
                      {fmt(k.ho_fail_rate * 100, 1)}%
                    </td>
                    <td className={`px-4 py-2.5 text-right font-mono ${k.packet_loss_pct > 1 ? 'text-amber-600' : 'text-gray-700 dark:text-gray-300'}`}>
                      {fmt(k.packet_loss_pct, 2)}%
                    </td>
                    <td className="px-4 py-2.5 text-center">{energyBadge(k.energy_mode)}</td>
                    <td className="px-4 py-2.5 text-center">
                      {k.sla_violation
                        ? <span className="text-xs font-bold text-red-600 bg-red-100 dark:bg-red-900 px-2 py-0.5 rounded">BREACH</span>
                        : <span className="text-xs text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950 px-2 py-0.5 rounded">OK</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {metrics.data && (
          <div className="text-right text-xs text-gray-400 dark:text-gray-500 mt-1">Auto-refresh every 5 s</div>
        )}
      </div>

      {/* Recent events */}
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-3">Recent Network Events</h2>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
          {events.isError && (
            <div className="p-4 text-sm text-gray-400 dark:text-gray-500 text-center">No event data available</div>
          )}
          {(events.data?.events ?? []).length === 0 && !events.isError && (
            <div className="p-4 text-sm text-gray-400 dark:text-gray-500 text-center">No events yet</div>
          )}
          {(events.data?.events ?? []).map((ev) => {
            const sev = (ev as { severity?: string }).severity ?? ''
            const sevCls = sev === 'critical' ? 'text-red-700 bg-red-50 dark:text-red-400 dark:bg-red-950'
              : sev === 'high'   ? 'text-orange-700 bg-orange-50 dark:text-orange-400 dark:bg-orange-950'
              : sev === 'medium' ? 'text-amber-700 bg-amber-50 dark:text-amber-400 dark:bg-amber-950'
              : 'text-gray-700 bg-gray-50 dark:text-gray-300 dark:bg-gray-700'
            return (
              <div key={ev.event_id} className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-50 dark:border-gray-700 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-700 text-sm">
                <span className={`text-xs font-semibold px-2 py-0.5 rounded ${sevCls}`}>{ev.event_type}</span>
                <span className="font-mono text-gray-600 dark:text-gray-300">{ev.entity_id}</span>
                {sev && <span className="text-gray-400 dark:text-gray-500 text-xs">{sev}</span>}
                <span className="ml-auto text-xs text-gray-400 dark:text-gray-500 font-mono">
                  {ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : ''}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
