import { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import type { EChartsOption } from 'echarts'
import { useLatestKpis, useTelemetry } from '../api/telemetry'
import { Chart, chartBase } from '../components/Chart'
import { CellActions } from '../components/CellActions'
import { EventFeed } from '../components/EventFeed'
import { Panel } from '../components/Panel'
import { Stat } from '../components/Stat'
import { Led, Tag } from '../components/Led'
import { C, KPI_LEVEL, energyLevel, linkLevel, withAlpha } from '../lib/status'
import { num, pct } from '../lib/format'
import { alignedTicks, cellSeries, tickLabels } from '../lib/series'
import type { KpiKey } from '../lib/series'

interface PairSpec {
  label: string
  left: { key: KpiKey; name: string; hex: string; area?: boolean; max?: number }
  right: { key: KpiKey; name: string; hex: string; scale?: number }
}

const PAIRS: PairSpec[] = [
  {
    label: 'Load & Throughput',
    left: { key: 'prb_util', name: 'PRB %', hex: C.amber, area: true, max: 100 },
    right: { key: 'throughput_mbps', name: 'Mb/s', hex: C.teal },
  },
  {
    label: 'Radio Quality',
    left: { key: 'sinr_db', name: 'SINR dB', hex: C.steel, area: true },
    right: { key: 'cqi', name: 'CQI', hex: C.lime },
  },
  {
    label: 'Latency & Loss',
    left: { key: 'latency_p95_ms', name: 'ms', hex: C.coral, area: true },
    right: { key: 'packet_loss_pct', name: '%', hex: C.sand },
  },
  {
    label: 'Mobility & Compute',
    left: { key: 'ho_fail_rate', name: 'HO fail %', hex: C.clay, area: true, max: undefined },
    right: { key: 'cpu_load_pct', name: 'CPU %', hex: C.steel },
  },
]

export function CellDetail() {
  const { cellId = '' } = useParams()
  const { frame, history, events } = useTelemetry()
  const latest = useLatestKpis()

  const cell = frame?.cells?.[cellId]
  const link = frame?.backhaul?.[cellId]
  const kpi = latest[cellId]

  const ticks = useMemo(() => {
    const own = history[cellId] ?? []
    return own.map((k) => k.tick).slice(-60)
  }, [history, cellId])
  const labels = useMemo(() => tickLabels(ticks), [ticks])
  const allTicks = useMemo(() => alignedTicks(history, 60), [history])

  const cellEvents = useMemo(
    () => events.filter((e) => e.entity_id === cellId),
    [events, cellId],
  )

  const options = useMemo<EChartsOption[]>(
    () =>
      PAIRS.map((pair) => {
        const base = chartBase()
        const leftData = cellSeries(history, cellId, pair.left.key, ticks).map((v) =>
          v !== null && pair.left.key === 'ho_fail_rate' ? Number((v * 100).toFixed(2)) : v,
        )
        const rightData = cellSeries(history, cellId, pair.right.key, ticks)
        return {
          ...base,
          grid: { left: 44, right: 44, top: 22, bottom: 24 },
          legend: {
            show: true,
            top: 0,
            right: 0,
            itemWidth: 8,
            itemHeight: 2,
            textStyle: { color: C.ink3, fontSize: 9, fontFamily: 'JetBrains Mono' },
          },
          xAxis: { ...base.xAxis, data: labels },
          yAxis: [
            { ...base.yAxis, max: pair.left.max },
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
              name: pair.left.name,
              type: 'line',
              data: leftData,
              showSymbol: false,
              smooth: 0.15,
              lineStyle: { color: pair.left.hex, width: 1.6 },
              areaStyle: pair.left.area
                ? { color: withAlpha(pair.left.hex, 0.09) }
                : undefined,
            },
            {
              name: pair.right.name,
              type: 'line',
              yAxisIndex: 1,
              data: rightData,
              showSymbol: false,
              smooth: 0.15,
              lineStyle: { color: pair.right.hex, width: 1.3, type: 'dashed' },
            },
          ],
        } as EChartsOption
      }),
    [history, cellId, ticks, labels],
  )

  if (!cellId) return null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/topology" className="btn px-2 py-1">
          <ChevronLeft size={12} />
          Topology
        </Link>
        <h1 className="num text-[18px] tracking-[0.18em] text-ink">{cellId}</h1>
        {cell ? (
          <>
            <Tag level={energyLevel(cell.energy_mode)}>{cell.energy_mode}</Tag>
            <Tag level={linkLevel(link?.status ?? 'UP')}>BACKHAUL {link?.status ?? '—'}</Tag>
          </>
        ) : null}
        {kpi?.sla_violation ? <Tag level="critical">SLA breach</Tag> : null}
        {kpi?.is_peak ? <Tag level="elevated">Peak hour</Tag> : null}
        <span className="num ml-auto text-[10px] text-ink3">
          {ticks.length} ticks buffered · window {allTicks.length}
        </span>
      </div>

      {!cell ? (
        <Panel label="Unknown cell">
          <p className="text-[12px] text-ink3">
            No cell {cellId} in the current topology frame. It may not exist, or the twin has not
            reported yet.
          </p>
        </Panel>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="PRB Utilisation"
          value={num(kpi?.prb_util, 1)}
          unit="%"
          level={kpi ? KPI_LEVEL.prb_util(kpi.prb_util) : 'idle'}
          fill={(kpi?.prb_util ?? 0) / 100}
        />
        <Stat
          label="Throughput"
          value={num(kpi?.throughput_mbps, 0)}
          unit="Mb/s"
          level="nominal"
        />
        <Stat
          label="Latency p95"
          value={num(kpi?.latency_p95_ms, 1)}
          unit="ms"
          level={kpi ? KPI_LEVEL.latency_p95_ms(kpi.latency_p95_ms) : 'idle'}
        />
        <Stat
          label="SINR"
          value={num(kpi?.sinr_db, 1)}
          unit="dB"
          sub={`CQI ${kpi?.cqi ?? '—'}`}
          level={kpi ? KPI_LEVEL.sinr_db(kpi.sinr_db) : 'idle'}
        />
        <Stat
          label="HO Failure"
          value={pct((kpi?.ho_fail_rate ?? 0) * 100, 1)}
          sub={`${cell?.ho_failures ?? 0} / ${cell?.ho_attempts ?? 0} attempts`}
          level={kpi ? KPI_LEVEL.ho_fail_rate(kpi.ho_fail_rate) : 'idle'}
        />
        <Stat
          label="Effective PRB"
          value={cell?.effective_prb ?? '—'}
          unit={`/ ${cell?.max_prb ?? 100}`}
          sub={`load factor ${num(cell?.current_load, 2)}`}
          level={cell && cell.effective_prb < cell.max_prb ? 'elevated' : 'nominal'}
        />
      </div>

      <div className="flex flex-col gap-3 xl:flex-row">
        <div className="grid min-w-0 flex-1 content-start grid-cols-1 gap-3 lg:grid-cols-2">
          {PAIRS.map((pair, i) => (
            <Panel key={pair.label} label={pair.label} className="h-[220px]" bodyClassName="p-2">
              <Chart option={options[i]} />
            </Panel>
          ))}
        </div>

        <div className="flex w-full flex-col gap-3 xl:w-[330px] xl:shrink-0">
          <Panel label="Control">
            <CellActions cell={cell} />
          </Panel>

          <Panel label="Backhaul & Neighbours">
            <div className="mb-3 grid grid-cols-3 gap-y-2">
              <div>
                <div className="label mb-1">Delay</div>
                <div className="num text-[13px] text-ink">{num(link?.delay_ms, 1)} ms</div>
              </div>
              <div>
                <div className="label mb-1">Loss</div>
                <div className="num text-[13px] text-ink">{num(link?.loss_pct, 2)} %</div>
              </div>
              <div>
                <div className="label mb-1">Status</div>
                <div className="num flex items-center gap-1.5 text-[13px] text-ink">
                  <Led level={linkLevel(link?.status ?? 'UP')} size={6} />
                  {link?.status ?? '—'}
                </div>
              </div>
            </div>
            <div className="label mb-1.5">Neighbours</div>
            <div className="flex flex-wrap gap-1.5">
              {(cell?.neighbours ?? []).map((nb) => (
                <Link key={nb} to={`/cells/${nb}`} className="btn px-2 py-1">
                  <Led
                    level={latest[nb] ? KPI_LEVEL.prb_util(latest[nb].prb_util) : 'idle'}
                    size={5}
                  />
                  {nb}
                  <span className="text-ink3">{num(latest[nb]?.prb_util, 0)}%</span>
                </Link>
              ))}
            </div>
          </Panel>

          <Panel
            label={`Events · ${cellId}`}
            meta={`${cellEvents.length}`}
            className="min-h-[140px] flex-1"
            bodyClassName="overflow-y-auto xl:max-h-[260px]"
            flush
          >
            <EventFeed events={cellEvents} limit={25} linkEntities={false} />
          </Panel>
        </div>
      </div>
    </div>
  )
}
