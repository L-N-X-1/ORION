import { useNavigate } from 'react-router-dom'
import type { CellKPI } from '../api/types'
import type { Level } from '../lib/status'
import { KPI_LEVEL, LEVEL_HEX, withAlpha } from '../lib/status'
import { num } from '../lib/format'

interface Column {
  key: string
  label: string
  read: (k: CellKPI) => number
  level: (k: CellKPI) => Level
  digits: number
}

const COLUMNS: Column[] = [
  {
    key: 'prb',
    label: 'PRB',
    read: (k) => k.prb_util,
    level: (k) => KPI_LEVEL.prb_util(k.prb_util),
    digits: 0,
  },
  {
    // Throughput follows offered demand, so a low reading is not a fault —
    // it stays neutral and is here for context, not for triage.
    key: 'thr',
    label: 'Thr',
    read: (k) => k.throughput_mbps,
    level: () => 'idle',
    digits: 0,
  },
  {
    key: 'sinr',
    label: 'SINR',
    read: (k) => k.sinr_db,
    level: (k) => KPI_LEVEL.sinr_db(k.sinr_db),
    digits: 0,
  },
  { key: 'cqi', label: 'CQI', read: (k) => k.cqi, level: (k) => KPI_LEVEL.cqi(k.cqi), digits: 0 },
  {
    key: 'lat',
    label: 'Lat',
    read: (k) => k.latency_p95_ms,
    level: (k) => KPI_LEVEL.latency_p95_ms(k.latency_p95_ms),
    digits: 0,
  },
  {
    key: 'loss',
    label: 'Loss',
    read: (k) => k.packet_loss_pct,
    level: (k) => KPI_LEVEL.packet_loss_pct(k.packet_loss_pct),
    digits: 1,
  },
  {
    key: 'cpu',
    label: 'CPU',
    read: (k) => k.cpu_load_pct,
    level: (k) => KPI_LEVEL.cpu_load_pct(k.cpu_load_pct),
    digits: 0,
  },
  {
    key: 'ho',
    label: 'HO',
    read: (k) => k.ho_fail_rate * 100,
    level: (k) => KPI_LEVEL.ho_fail_rate(k.ho_fail_rate),
    digits: 0,
  },
]

/**
 * Cross-KPI heat grid: the cell rail answers "how is C11 trending", this
 * answers "which KPI is hot, and where".
 */
export function KpiMatrix({ latest }: { latest: Record<string, CellKPI> }) {
  const navigate = useNavigate()
  const rows = Object.keys(latest).sort()

  if (rows.length === 0) {
    return (
      <div className="flex h-[120px] items-center justify-center">
        <span className="label">Waiting for KPIs…</span>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="label px-2 py-1 text-left">Cell</th>
            {COLUMNS.map((c) => (
              <th key={c.key} className="label px-2 py-1 text-right">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((id) => {
            const kpi = latest[id]
            return (
              <tr
                key={id}
                className="cursor-pointer"
                onClick={() => navigate(`/cells/${id}`)}
              >
                <td className="num px-2 py-[3px] text-[11px] text-ink2">{id}</td>
                {COLUMNS.map((c) => {
                  const level = c.level(kpi)
                  const hex = LEVEL_HEX[level]
                  return (
                    <td key={c.key} className="px-[3px] py-[2px]">
                      <div
                        className="num flex h-[20px] items-center justify-end px-1.5 text-[11px]"
                        style={{
                          backgroundColor: withAlpha(hex, level === 'nominal' ? 0.07 : 0.2),
                          color: level === 'nominal' ? '#9E978B' : hex,
                          borderRight: `2px solid ${withAlpha(hex, level === 'nominal' ? 0.25 : 0.85)}`,
                        }}
                      >
                        {num(c.read(kpi), c.digits)}
                      </div>
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
