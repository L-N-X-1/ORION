import type { CellKPI } from '../api/types'

export type KpiKey =
  | 'prb_util'
  | 'throughput_mbps'
  | 'sinr_db'
  | 'cqi'
  | 'latency_p95_ms'
  | 'packet_loss_pct'
  | 'cpu_load_pct'
  | 'ho_fail_rate'

export interface Point {
  tick: number
  value: number
}

export type History = Record<string, CellKPI[]>

/** Ticks present anywhere in the history, ascending, capped to the last `limit`. */
export function alignedTicks(history: History, limit = 60): number[] {
  const set = new Set<number>()
  for (const buf of Object.values(history)) {
    for (const kpi of buf) set.add(kpi.tick)
  }
  const ticks = [...set].sort((a, b) => a - b)
  return ticks.slice(Math.max(0, ticks.length - limit))
}

function indexByTick(buf: CellKPI[]): Map<number, CellKPI> {
  const m = new Map<number, CellKPI>()
  for (const kpi of buf) m.set(kpi.tick, kpi)
  return m
}

/** One cell, one KPI, aligned onto the supplied tick axis. */
export function cellSeries(
  history: History,
  cellId: string,
  key: KpiKey,
  ticks: number[],
): (number | null)[] {
  const idx = indexByTick(history[cellId] ?? [])
  return ticks.map((t) => {
    const kpi = idx.get(t)
    return kpi ? (kpi[key] as number) : null
  })
}

/** Network-wide roll-up of one KPI across every cell. */
export function aggregateSeries(
  history: History,
  key: KpiKey,
  mode: 'sum' | 'avg',
  ticks: number[],
): (number | null)[] {
  const indexes = Object.values(history).map(indexByTick)
  return ticks.map((t) => {
    let total = 0
    let n = 0
    for (const idx of indexes) {
      const kpi = idx.get(t)
      if (!kpi) continue
      total += kpi[key] as number
      n += 1
    }
    if (n === 0) return null
    return mode === 'sum' ? Number(total.toFixed(2)) : Number((total / n).toFixed(2))
  })
}

/** Count of cells breaching SLA at each tick. */
export function slaSeries(history: History, ticks: number[]): number[] {
  const indexes = Object.values(history).map(indexByTick)
  return ticks.map((t) => {
    let n = 0
    for (const idx of indexes) {
      if (idx.get(t)?.sla_violation) n += 1
    }
    return n
  })
}

/** Short tick labels for the x-axis — absolute tick numbers stay meaningful. */
export function tickLabels(ticks: number[]): string[] {
  return ticks.map((t) => String(t))
}

export function lastValue(series: (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const v = series[i]
    if (v !== null && v !== undefined) return v
  }
  return null
}

/** Cells ranked by a KPI, highest first. */
export function rankCells(
  latest: Record<string, CellKPI>,
  key: KpiKey,
  topN: number,
): string[] {
  return Object.values(latest)
    .slice()
    .sort((a, b) => (b[key] as number) - (a[key] as number))
    .slice(0, topN)
    .map((k) => k.cell_id)
}
