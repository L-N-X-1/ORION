import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { FlaskConical } from 'lucide-react'
import type { EChartsOption } from 'echarts'
import { useTelemetry } from '../api/telemetry'
import { twin } from '../api/twin'
import type { WhatIfReport } from '../api/types'
import { Chart, chartBase } from '../components/Chart'
import { Panel } from '../components/Panel'
import { Stat } from '../components/Stat'
import { useToast } from '../components/Toaster'
import { C, withAlpha } from '../lib/status'
import { num, signed } from '../lib/format'

type ActionType = 'apply_slice_policy' | 'tune_handover' | 'enable_energy_saving'

const ACTIONS: { id: ActionType; label: string; blurb: string }[] = [
  {
    id: 'apply_slice_policy',
    label: 'Slice policy',
    blurb: 'Re-shape a slice envelope. Also clears an active synthetic congestion fault.',
  },
  {
    id: 'tune_handover',
    label: 'Handover tuning',
    blurb: 'Change A3 offset and time-to-trigger on one cell.',
  },
  {
    id: 'enable_energy_saving',
    label: 'Energy mode',
    blurb: 'Move a cell between ACTIVE, SLEEP and SHUTDOWN.',
  },
]

/** Lower is better for everything except throughput. */
const BETTER_WHEN_LOWER: Record<string, boolean> = {
  prb_util: true,
  latency_p95_ms: true,
  packet_loss_pct: true,
  throughput_mbps: false,
}

/** Anything under this is simulation noise, not a forecast signal. */
const DELTA_EPSILON = 0.05

function deltaColour(key: string, value: number): string {
  if (Math.abs(value) < DELTA_EPSILON) return C.ink3
  const good = BETTER_WHEN_LOWER[key] ? value < 0 : value > 0
  return good ? C.teal : C.coral
}

function deltaText(value: number, digits: number): string {
  return Math.abs(value) < DELTA_EPSILON ? '·' : signed(value, digits)
}

export function WhatIfPage() {
  const { frame, cellIds } = useTelemetry()
  const toast = useToast()

  const [actionType, setActionType] = useState<ActionType>('apply_slice_policy')
  const [horizon, setHorizon] = useState('120')
  const [affected, setAffected] = useState('')

  const [sliceId, setSliceId] = useState('slice-premium')
  const [minBw, setMinBw] = useState('30')
  const [maxBw, setMaxBw] = useState('90')
  const [priority, setPriority] = useState('1')

  const [cellId, setCellId] = useState('C00')
  const [a3, setA3] = useState('3.0')
  const [ttt, setTtt] = useState('40')
  const [mode, setMode] = useState('SLEEP')

  const [report, setReport] = useState<WhatIfReport | null>(null)

  const sliceOptions = useMemo(() => Object.keys(frame?.slices ?? {}), [frame])

  const actionPlan = useMemo<Record<string, unknown>>(() => {
    const params: Record<string, unknown> =
      actionType === 'apply_slice_policy'
        ? {
            slice_id: sliceId,
            min_bw_pct: Number(minBw),
            max_bw_pct: Number(maxBw),
            priority: Number(priority),
          }
        : actionType === 'tune_handover'
          ? { cell_id: cellId, a3_offset: Number(a3), ttt_ms: Number(ttt) }
          : { cell_id: cellId, mode }

    const cells = affected
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const plan: Record<string, unknown> = { action_type: actionType, params }
    if (cells.length) plan.affected_cells = cells
    return plan
  }, [actionType, sliceId, minBw, maxBw, priority, cellId, a3, ttt, mode, affected])

  const run = useMutation({
    mutationFn: () => twin.whatIf(actionPlan, Number(horizon) || 120),
    onSuccess: (res) => {
      setReport(res)
      toast.ok(
        'Forecast complete',
        `${res.cells_analysed} cells over ${res.horizon_minutes} simulated minutes`,
      )
    },
    onError: (err: Error) => toast.fail('What-if failed', err.message),
  })

  const compareOption = useMemo<EChartsOption>(() => {
    const base = chartBase()
    const rows = report?.per_cell ?? []
    return {
      ...base,
      grid: { left: 46, right: 44, top: 26, bottom: 30 },
      tooltip: { ...base.tooltip, axisPointer: { type: 'shadow' } },
      legend: {
        show: true,
        top: 0,
        right: 0,
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: C.ink3, fontSize: 9, fontFamily: 'JetBrains Mono' },
      },
      xAxis: {
        ...base.xAxis,
        type: 'category',
        boundaryGap: true,
        data: rows.map((r) => r.cell_id),
      },
      yAxis: [
        { ...base.yAxis, max: 100 },
        {
          type: 'value',
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { color: C.ink3, fontSize: 9, fontFamily: 'JetBrains Mono' },
        },
      ],
      series: [
        {
          name: 'PRB baseline',
          type: 'bar',
          data: rows.map((r) => r.baseline.prb_util),
          barMaxWidth: 12,
          itemStyle: { color: withAlpha(C.ink3, 0.55) },
        },
        {
          name: 'PRB with action',
          type: 'bar',
          data: rows.map((r) => r.with_action.prb_util),
          barMaxWidth: 12,
          itemStyle: { color: C.amber },
        },
        {
          name: 'Latency baseline',
          type: 'line',
          yAxisIndex: 1,
          data: rows.map((r) => r.baseline.latency_p95_ms),
          showSymbol: true,
          symbolSize: 5,
          lineStyle: { color: withAlpha(C.coral, 0.45), width: 1, type: 'dashed' },
          itemStyle: { color: withAlpha(C.coral, 0.6) },
        },
        {
          name: 'Latency with action',
          type: 'line',
          yAxisIndex: 1,
          data: rows.map((r) => r.with_action.latency_p95_ms),
          showSymbol: true,
          symbolSize: 5,
          lineStyle: { color: C.teal, width: 1.4 },
          itemStyle: { color: C.teal },
        },
      ],
    }
  }, [report])

  const improvement = report?.overall.sla_improvement ?? 0

  return (
    <div className="flex flex-col gap-3 xl:flex-row">
      <Panel label="Action Plan" className="xl:w-[340px] xl:shrink-0">
        <div className="flex flex-col gap-3">
          <div>
            <div className="label mb-1.5">Action type</div>
            <div className="flex flex-col gap-1">
              {ACTIONS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`btn justify-start ${actionType === a.id ? 'btn-primary' : ''}`}
                  onClick={() => setActionType(a.id)}
                >
                  {a.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-snug text-ink3">
              {ACTIONS.find((a) => a.id === actionType)?.blurb}
            </p>
          </div>

          {actionType === 'apply_slice_policy' ? (
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1">
                <span className="num text-[10px] text-ink3">slice</span>
                <select
                  className="field"
                  value={sliceId}
                  onChange={(e) => setSliceId(e.target.value)}
                >
                  {(sliceOptions.length ? sliceOptions : ['slice-premium']).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-3 gap-2">
                <label className="flex flex-col gap-1">
                  <span className="num text-[10px] text-ink3">min %</span>
                  <input
                    className="field"
                    type="number"
                    value={minBw}
                    onChange={(e) => setMinBw(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="num text-[10px] text-ink3">max %</span>
                  <input
                    className="field"
                    type="number"
                    value={maxBw}
                    onChange={(e) => setMaxBw(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="num text-[10px] text-ink3">prio</span>
                  <input
                    className="field"
                    type="number"
                    value={priority}
                    onChange={(e) => setPriority(e.target.value)}
                  />
                </label>
              </div>
            </div>
          ) : null}

          {actionType !== 'apply_slice_policy' ? (
            <label className="flex flex-col gap-1">
              <span className="num text-[10px] text-ink3">cell</span>
              <select className="field" value={cellId} onChange={(e) => setCellId(e.target.value)}>
                {(cellIds.length ? cellIds : ['C00']).map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {actionType === 'tune_handover' ? (
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="num text-[10px] text-ink3">A3 offset dB</span>
                <input
                  className="field"
                  type="number"
                  step="0.1"
                  value={a3}
                  onChange={(e) => setA3(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="num text-[10px] text-ink3">TTT ms</span>
                <input
                  className="field"
                  type="number"
                  value={ttt}
                  onChange={(e) => setTtt(e.target.value)}
                />
              </label>
            </div>
          ) : null}

          {actionType === 'enable_energy_saving' ? (
            <label className="flex flex-col gap-1">
              <span className="num text-[10px] text-ink3">mode</span>
              <select className="field" value={mode} onChange={(e) => setMode(e.target.value)}>
                {['ACTIVE', 'SLEEP', 'SHUTDOWN'].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="num text-[10px] text-ink3">horizon ticks</span>
              <input
                className="field"
                type="number"
                value={horizon}
                onChange={(e) => setHorizon(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="num text-[10px] text-ink3">affected cells</span>
              <input
                className="field"
                value={affected}
                placeholder="all"
                onChange={(e) => setAffected(e.target.value)}
              />
            </label>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            disabled={run.isPending}
            onClick={() => run.mutate()}
          >
            <FlaskConical size={12} />
            {run.isPending ? 'Simulating…' : 'Run forecast'}
          </button>

          <div>
            <div className="label mb-1">Payload</div>
            <pre className="num max-h-[160px] overflow-auto border border-line bg-void p-2 text-[10px] leading-relaxed text-ink3">
              {JSON.stringify(actionPlan, null, 2)}
            </pre>
          </div>
        </div>
      </Panel>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="SLA Breaches · Baseline"
            value={report ? report.overall.sla_violations_baseline : '—'}
            level={report ? 'elevated' : 'idle'}
          />
          <Stat
            label="SLA Breaches · With Action"
            value={report ? report.overall.sla_violations_action : '—'}
            level={report ? (improvement > 0 ? 'nominal' : 'critical') : 'idle'}
          />
          <Stat
            label="Net Improvement"
            value={report ? signed(improvement, 0) : '—'}
            unit="breaches avoided"
            level={improvement > 0 ? 'nominal' : improvement < 0 ? 'critical' : 'idle'}
          />
          <Stat
            label="Confidence"
            value={report ? num(report.overall.confidence * 100, 0) : '—'}
            unit="%"
            fill={report?.overall.confidence}
            level={
              !report
                ? 'idle'
                : report.overall.confidence > 0.6
                  ? 'nominal'
                  : report.overall.confidence > 0.3
                    ? 'elevated'
                    : 'critical'
            }
            sub={report ? `${report.horizon_minutes} simulated minutes` : undefined}
          />
        </div>

        <Panel
          label="Baseline vs With Action"
          meta={
            report
              ? `${report.cells_analysed} cells · bars PRB % · lines latency ms`
              : 'no forecast yet'
          }
          className="h-[280px]"
          bodyClassName="p-2"
        >
          {report ? (
            <Chart option={compareOption} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <span className="label">No forecast yet</span>
              <p className="max-w-[380px] text-[11px] leading-snug text-ink3">
                The twin clones its live world state, runs the horizon twice — once untouched and
                once with your action applied — and returns the delta. Nothing here mutates the
                live network.
              </p>
            </div>
          )}
        </Panel>

        <Panel
          label="Per-Cell Delta"
          meta={report ? `horizon ${report.horizon_ticks} ticks` : undefined}
          flush
          bodyClassName="overflow-x-auto"
        >
          {!report ? (
            <div className="px-3 py-8 text-center">
              <span className="label">Run a forecast to populate</span>
            </div>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line">
                  {[
                    'Cell',
                    'PRB base',
                    'PRB action',
                    'Δ PRB',
                    'Lat base',
                    'Lat action',
                    'Δ Lat',
                    'Δ Thr',
                    'SLA base',
                    'SLA action',
                  ].map((h, i) => (
                    <th
                      key={h}
                      className={`label px-3 py-2 ${i === 0 ? 'text-left' : 'text-right'}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.per_cell.map((r) => (
                  <tr key={r.cell_id} className="row-hover border-b border-line/60">
                    <td className="num px-3 py-1.5 text-[12px] text-ink">{r.cell_id}</td>
                    <td className="num px-3 py-1.5 text-right text-[12px] text-ink3">
                      {num(r.baseline.prb_util, 1)}
                    </td>
                    <td className="num px-3 py-1.5 text-right text-[12px] text-ink">
                      {num(r.with_action.prb_util, 1)}
                    </td>
                    <td
                      className="num px-3 py-1.5 text-right text-[12px]"
                      style={{ color: deltaColour('prb_util', r.delta.prb_util) }}
                    >
                      {deltaText(r.delta.prb_util, 1)}
                    </td>
                    <td className="num px-3 py-1.5 text-right text-[12px] text-ink3">
                      {num(r.baseline.latency_p95_ms, 1)}
                    </td>
                    <td className="num px-3 py-1.5 text-right text-[12px] text-ink">
                      {num(r.with_action.latency_p95_ms, 1)}
                    </td>
                    <td
                      className="num px-3 py-1.5 text-right text-[12px]"
                      style={{ color: deltaColour('latency_p95_ms', r.delta.latency_p95_ms) }}
                    >
                      {deltaText(r.delta.latency_p95_ms, 1)}
                    </td>
                    <td
                      className="num px-3 py-1.5 text-right text-[12px]"
                      style={{ color: deltaColour('throughput_mbps', r.delta.throughput_mbps) }}
                    >
                      {deltaText(r.delta.throughput_mbps, 1)}
                    </td>
                    <td className="num px-3 py-1.5 text-right text-[12px] text-ink3">
                      {r.baseline.sla_violations}
                    </td>
                    <td
                      className="num px-3 py-1.5 text-right text-[12px]"
                      style={{
                        color:
                          r.with_action.sla_violations < r.baseline.sla_violations
                            ? C.teal
                            : r.with_action.sla_violations > r.baseline.sla_violations
                              ? C.coral
                              : C.ink3,
                      }}
                    >
                      {r.with_action.sla_violations}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  )
}
