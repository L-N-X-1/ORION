import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { EChartsOption } from 'echarts'
import { useLatestKpis, useTelemetry } from '../api/telemetry'
import { POLL_SLOW, twin } from '../api/twin'
import { Chart, chartBase } from '../components/Chart'
import { Panel } from '../components/Panel'
import { Stat } from '../components/Stat'
import { Led } from '../components/Led'
import { useToast } from '../components/Toaster'
import { C, KPI_LEVEL, LEVEL_HEX, SERIES, withAlpha } from '../lib/status'
import { int, num, pct } from '../lib/format'
import { alignedTicks, cellSeries, rankCells, tickLabels } from '../lib/series'

/** Below this A3 offset the twin lowers the handover trigger threshold — a storm. */
const A3_STORM_THRESHOLD = 1.0

export function MobilityPage() {
  const { frame, history } = useTelemetry()
  const latest = useLatestKpis()
  const toast = useToast()
  const qc = useQueryClient()

  const cells = useMemo(() => Object.values(frame?.cells ?? {}), [frame])
  const ues = useQuery({ queryKey: ['ues'], queryFn: twin.ues, refetchInterval: POLL_SLOW })

  const totals = useMemo(() => {
    const attempts = cells.reduce((sum, c) => sum + c.ho_attempts, 0)
    const failures = cells.reduce((sum, c) => sum + c.ho_failures, 0)
    const storms = cells.filter((c) => c.a3_offset < A3_STORM_THRESHOLD)
    const worst = Object.values(latest).reduce(
      (max, k) => Math.max(max, k.ho_fail_rate),
      0,
    )
    return {
      attempts,
      failures,
      rate: attempts ? failures / attempts : 0,
      storms,
      worst,
    }
  }, [cells, latest])

  const ticks = useMemo(() => alignedTicks(history, 60), [history])
  const labels = useMemo(() => tickLabels(ticks), [ticks])

  const failOption = useMemo<EChartsOption>(() => {
    const base = chartBase()
    const top = rankCells(latest, 'ho_fail_rate', 4)
    return {
      ...base,
      grid: { left: 42, right: 14, top: 24, bottom: 26 },
      legend: {
        show: true,
        top: 0,
        right: 0,
        itemWidth: 8,
        itemHeight: 2,
        textStyle: { color: C.ink3, fontSize: 9, fontFamily: 'JetBrains Mono' },
      },
      xAxis: { ...base.xAxis, data: labels },
      yAxis: { ...base.yAxis, name: '%', nameTextStyle: { color: C.ink3, fontSize: 9 } },
      series: [
        {
          name: '10% threshold',
          type: 'line',
          data: ticks.map(() => 10),
          showSymbol: false,
          lineStyle: { color: withAlpha(C.coral, 0.5), width: 1, type: 'dashed' },
        },
        ...top.map((id, i) => ({
          name: id,
          type: 'line' as const,
          data: cellSeries(history, id, 'ho_fail_rate', ticks).map((v) =>
            v === null ? null : Number((v * 100).toFixed(2)),
          ),
          showSymbol: false,
          smooth: 0.15,
          lineStyle: { color: SERIES[i % SERIES.length], width: 1.5 },
        })),
      ],
    }
  }, [history, latest, ticks, labels])

  const scatterOption = useMemo<EChartsOption>(() => {
    const base = chartBase()
    return {
      ...base,
      grid: { left: 50, right: 24, top: 30, bottom: 36 },
      tooltip: {
        ...base.tooltip,
        trigger: 'item',
        formatter: (p: unknown) => {
          const params = p as { data: [number, number, string] }
          return `${params.data[2]}<br/>A3 ${params.data[0]} dB<br/>HO fail ${params.data[1]}%`
        },
      },
      xAxis: {
        type: 'value',
        name: 'A3 offset (dB)',
        min: 0,
        max: 4,
        nameLocation: 'middle',
        nameGap: 22,
        nameTextStyle: { color: C.ink3, fontSize: 9, fontFamily: 'JetBrains Mono' },
        axisLine: { lineStyle: { color: C.line2 } },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: C.line } },
        axisLabel: { color: C.ink3, fontSize: 9, fontFamily: 'JetBrains Mono' },
      },
      yAxis: {
        ...base.yAxis,
        name: 'HO fail %',
        nameGap: 12,
        nameTextStyle: { color: C.ink3, fontSize: 9, fontFamily: 'JetBrains Mono', align: 'left' },
      },
      series: [
        {
          type: 'scatter',
          symbolSize: 9,
          data: cells.map((c) => [
            c.a3_offset,
            Number(((latest[c.cell_id]?.ho_fail_rate ?? 0) * 100).toFixed(2)),
            c.cell_id,
          ]),
          itemStyle: {
            color: (p: { data: unknown }) => {
              const d = p.data as [number, number, string]
              return d[0] < A3_STORM_THRESHOLD ? C.coral : C.teal
            },
          },
          markLine: {
            silent: true,
            symbol: 'none',
            label: {
              color: C.ink3,
              fontSize: 9,
              fontFamily: 'JetBrains Mono',
              formatter: 'storm threshold',
            },
            lineStyle: { color: withAlpha(C.amber, 0.6), type: 'dashed' },
            data: [{ xAxis: A3_STORM_THRESHOLD }],
          },
        },
      ],
    }
  }, [cells, latest])

  const restore = useMutation({
    mutationFn: (cellId: string) => twin.restoreFault('handover_params', { cell_id: cellId }),
    onSuccess: (_res, cellId) => {
      toast.ok(`${cellId} handover parameters restored`)
      void qc.invalidateQueries({ queryKey: ['faults'] })
    },
    onError: (err: Error) => toast.fail('Restore failed', err.message),
  })

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Handover Attempts" value={int(totals.attempts)} level="nominal" />
        <Stat
          label="Handover Failures"
          value={int(totals.failures)}
          level={totals.failures > 0 ? 'elevated' : 'nominal'}
        />
        <Stat
          label="Network Fail Rate"
          value={pct(totals.rate * 100, 2)}
          level={KPI_LEVEL.ho_fail_rate(totals.rate)}
          fill={Math.min(1, totals.rate / 0.4)}
        />
        <Stat
          label="Cells Below A3 Threshold"
          value={int(totals.storms.length)}
          sub={totals.storms.map((c) => c.cell_id).join(' ') || 'none'}
          level={totals.storms.length ? 'critical' : 'nominal'}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel
          label="Handover Failure Rate"
          meta="worst 4 cells"
          className="h-[248px]"
          bodyClassName="p-2"
        >
          <Chart option={failOption} />
        </Panel>
        <Panel
          label="A3 Offset vs Failure Rate"
          meta="one point per cell"
          className="h-[248px]"
          bodyClassName="p-2"
        >
          <Chart option={scatterOption} />
        </Panel>
      </div>

      <Panel label="Per-Cell Mobility Register" meta={`${cells.length} cells`} flush>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-line">
                {['Cell', 'A3 offset', 'TTT', 'Attempts', 'Failures', 'Fail rate', 'UEs', ''].map(
                  (h, i) => (
                    <th
                      key={h || i}
                      className={`label px-3 py-2 ${i === 0 ? 'text-left' : 'text-right'}`}
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {cells.map((c) => {
                const kpi = latest[c.cell_id]
                const rate = kpi?.ho_fail_rate ?? 0
                const storm = c.a3_offset < A3_STORM_THRESHOLD
                return (
                  <tr key={c.cell_id} className="row-hover border-b border-line/60">
                    <td className="px-3 py-1.5">
                      <Link
                        to={`/cells/${c.cell_id}`}
                        className="num flex items-center gap-2 text-[12px] text-ink hover:text-amber"
                      >
                        <Led level={KPI_LEVEL.ho_fail_rate(rate)} size={6} />
                        {c.cell_id}
                      </Link>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <span
                        className="num text-[12px]"
                        style={{ color: storm ? C.coral : C.ink }}
                      >
                        {num(c.a3_offset, 2)}
                      </span>
                    </td>
                    <td className="num px-3 py-1.5 text-right text-[12px] text-ink2">
                      {num(c.ttt_ms, 0)}
                    </td>
                    <td className="num px-3 py-1.5 text-right text-[12px] text-ink2">
                      {int(c.ho_attempts)}
                    </td>
                    <td className="num px-3 py-1.5 text-right text-[12px] text-ink2">
                      {int(c.ho_failures)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <span
                        className="num text-[12px]"
                        style={{ color: LEVEL_HEX[KPI_LEVEL.ho_fail_rate(rate)] }}
                      >
                        {pct(rate * 100, 1)}
                      </span>
                    </td>
                    <td className="num px-3 py-1.5 text-right text-[12px] text-ink3">
                      {int(ues.data?.per_cell?.[c.cell_id]?.total)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {storm ? (
                        <button
                          type="button"
                          className="btn px-2 py-1"
                          disabled={restore.isPending}
                          onClick={() => restore.mutate(c.cell_id)}
                        >
                          Restore
                        </button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}
