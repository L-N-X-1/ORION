import { useMemo } from 'react'
import type { EChartsOption } from 'echarts'
import { useLatestKpis, useTelemetry } from '../api/telemetry'
import { Chart, chartBase } from '../components/Chart'
import { CellRail } from '../components/CellRail'
import { KpiMatrix } from '../components/KpiMatrix'
import { EventFeed } from '../components/EventFeed'
import { Panel } from '../components/Panel'
import { Stat } from '../components/Stat'
import { C, KPI_LEVEL, SERIES, withAlpha } from '../lib/status'
import { int, num } from '../lib/format'
import {
  aggregateSeries,
  alignedTicks,
  cellSeries,
  rankCells,
  slaSeries,
  tickLabels,
} from '../lib/series'

export function Overview() {
  const { history, events, cellIds, frame } = useTelemetry()
  const latest = useLatestKpis()

  const ticks = useMemo(() => alignedTicks(history, 60), [history])
  const labels = useMemo(() => tickLabels(ticks), [ticks])

  const totals = useMemo(() => {
    const kpis = Object.values(latest)
    const active = kpis.filter((k) => k.energy_mode === 'ACTIVE').length
    const throughput = kpis.reduce((sum, k) => sum + k.throughput_mbps, 0)
    const avgPrb = kpis.length
      ? kpis.reduce((sum, k) => sum + k.prb_util, 0) / kpis.length
      : 0
    const sla = kpis.filter((k) => k.sla_violation).length
    const worstLatency = kpis.reduce((max, k) => Math.max(max, k.latency_p95_ms), 0)
    return { count: kpis.length, active, throughput, avgPrb, sla, worstLatency }
  }, [latest])

  const throughputOption = useMemo<EChartsOption>(() => {
    const total = aggregateSeries(history, 'throughput_mbps', 'sum', ticks)
    const sla = slaSeries(history, ticks)
    return {
      ...chartBase(),
      grid: { left: 52, right: 40, top: 18, bottom: 26 },
      xAxis: { ...chartBase().xAxis, data: labels },
      yAxis: [
        {
          ...chartBase().yAxis,
          name: 'Mb/s',
          nameTextStyle: { color: C.ink3, fontSize: 9, fontFamily: 'JetBrains Mono' },
        },
        {
          type: 'value',
          min: 0,
          minInterval: 1,
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { color: C.ink3, fontSize: 9, fontFamily: 'JetBrains Mono' },
        },
      ],
      series: [
        {
          name: 'Aggregate throughput',
          type: 'line',
          data: total,
          showSymbol: false,
          smooth: 0.2,
          lineStyle: { color: C.teal, width: 1.6 },
          areaStyle: { color: withAlpha(C.teal, 0.1) },
        },
        {
          name: 'Cells in SLA breach',
          type: 'bar',
          yAxisIndex: 1,
          data: sla,
          barMaxWidth: 6,
          itemStyle: { color: withAlpha(C.coral, 0.55) },
        },
      ],
    }
  }, [history, ticks, labels])

  const prbOption = useMemo<EChartsOption>(() => {
    const top = rankCells(latest, 'prb_util', 4)
    const base = chartBase()
    return {
      ...base,
      grid: { left: 40, right: 14, top: 24, bottom: 26 },
      legend: {
        show: true,
        top: 0,
        right: 0,
        itemWidth: 8,
        itemHeight: 2,
        textStyle: { color: C.ink3, fontSize: 9, fontFamily: 'JetBrains Mono' },
      },
      xAxis: { ...base.xAxis, data: labels },
      yAxis: { ...base.yAxis, max: 100, min: 0 },
      series: [
        {
          name: 'net avg',
          type: 'line',
          data: aggregateSeries(history, 'prb_util', 'avg', ticks),
          showSymbol: false,
          lineStyle: { color: C.ink3, width: 1, type: 'dashed' },
        },
        ...top.map((id, i) => ({
          name: id,
          type: 'line' as const,
          data: cellSeries(history, id, 'prb_util', ticks),
          showSymbol: false,
          smooth: 0.15,
          lineStyle: { color: SERIES[i % SERIES.length], width: 1.5 },
        })),
      ],
    }
  }, [history, latest, ticks, labels])

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat
          label="Cells Reporting"
          value={int(totals.count)}
          unit={`/ ${cellIds.length || 12}`}
          sub={`${totals.active} active · ${totals.count - totals.active} power-saving`}
          level={totals.count === 0 ? 'idle' : 'nominal'}
        />
        <Stat
          label="Avg PRB Utilisation"
          value={num(totals.avgPrb, 1)}
          unit="%"
          level={KPI_LEVEL.prb_util(totals.avgPrb)}
          fill={totals.avgPrb / 100}
        />
        <Stat
          label="Aggregate Throughput"
          value={int(totals.throughput)}
          unit="Mb/s"
          sub={`peak window ${frame?.kpis?.[0]?.is_peak ? 'yes' : 'no'}`}
          level="nominal"
        />
        <Stat
          label="SLA Breaches"
          value={int(totals.sla)}
          unit="cells"
          level={totals.sla === 0 ? 'nominal' : totals.sla > 2 ? 'critical' : 'elevated'}
          fill={totals.sla / Math.max(1, totals.count)}
        />
        <Stat
          label="Worst Latency p95"
          value={num(totals.worstLatency, 0)}
          unit="ms"
          level={KPI_LEVEL.latency_p95_ms(totals.worstLatency)}
        />
      </div>

      <div className="flex flex-col gap-3 xl:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Panel
              label="Network Throughput"
              meta={`${ticks.length} ticks`}
              className="h-[236px]"
              bodyClassName="p-2"
            >
              <Chart option={throughputOption} />
            </Panel>
            <Panel
              label="PRB Utilisation · Top Loaded"
              meta="live"
              className="h-[236px]"
              bodyClassName="p-2"
            >
              <Chart option={prbOption} />
            </Panel>
          </div>

          <Panel label="Cell Grid" meta={`${cellIds.length} gNodeB`}>
            <CellRail cellIds={cellIds} latest={latest} history={history} />
          </Panel>

          <Panel label="KPI Matrix" meta="colour = threshold band" bodyClassName="p-2">
            <KpiMatrix latest={latest} />
          </Panel>
        </div>

        <Panel
          label="Event Stream"
          meta={`${events.length} buffered`}
          className="xl:w-[340px] xl:shrink-0"
          bodyClassName="overflow-y-auto xl:max-h-[calc(100vh-140px)]"
          flush
        >
          <EventFeed events={events} limit={60} />
        </Panel>
      </div>
    </div>
  )
}
