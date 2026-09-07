import { Link } from 'react-router-dom'
import type { CellKPI } from '../api/types'
import { KPI_LEVEL, LEVEL_HEX, loadHex, withAlpha } from '../lib/status'
import { num } from '../lib/format'
import type { History } from '../lib/series'

interface CellRailProps {
  cellIds: string[]
  latest: Record<string, CellKPI>
  history: History
}

function Sparkline({ values, hex }: { values: number[]; hex: string }) {
  if (values.length < 2) return <div className="h-6 w-full" />
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const step = 100 / (values.length - 1)
  const path = values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${(24 - ((v - min) / span) * 22).toFixed(2)}`)
    .join(' ')
  const area = `${path} L100,24 L0,24 Z`
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="h-6 w-full">
      <path d={area} fill={withAlpha(hex, 0.12)} />
      <path d={path} fill="none" stroke={hex} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** Dense strip of every cell — the operator's peripheral vision. */
export function CellRail({ cellIds, latest, history }: CellRailProps) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
      {cellIds.map((id) => {
        const kpi = latest[id]
        const prb = kpi?.prb_util ?? 0
        const level = KPI_LEVEL.prb_util(prb)
        const hex = loadHex(prb)
        const spark = (history[id] ?? []).slice(-30).map((k) => k.prb_util)
        return (
          <Link
            key={id}
            to={`/cells/${id}`}
            className="panel group px-2.5 py-2 transition-colors hover:border-line2"
          >
            <div className="flex items-center gap-2">
              <span className="num text-[12px] font-bold tracking-[0.12em] text-ink group-hover:text-amber">
                {id}
              </span>
              {kpi?.sla_violation ? (
                <span className="num text-[9px] uppercase tracking-[0.1em] text-coral">SLA</span>
              ) : null}
              {kpi && kpi.energy_mode !== 'ACTIVE' ? (
                <span className="num text-[9px] uppercase tracking-[0.1em] text-amber">
                  {kpi.energy_mode}
                </span>
              ) : null}
              <span
                className="num ml-auto text-[14px]"
                style={{ color: LEVEL_HEX[level] }}
              >
                {num(prb, 0)}
                <span className="text-[9px] text-ink3">%</span>
              </span>
            </div>
            <Sparkline values={spark} hex={hex} />
            <div className="flex items-baseline justify-between">
              <span className="num text-[10px] text-ink3">
                {num(kpi?.throughput_mbps, 0)} Mb/s
              </span>
              <span className="num text-[10px] text-ink3">{num(kpi?.latency_p95_ms, 0)} ms</span>
            </div>
          </Link>
        )
      })}
    </div>
  )
}
