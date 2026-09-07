import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useLatestKpis, useTelemetry } from '../api/telemetry'
import { Panel } from '../components/Panel'
import { Led } from '../components/Led'
import { KPI_LEVEL, LEVEL_HEX, energyLevel, linkLevel } from '../lib/status'
import { num } from '../lib/format'
import type { CellKPI } from '../api/types'

type SortKey =
  | 'cell_id'
  | 'prb_util'
  | 'throughput_mbps'
  | 'sinr_db'
  | 'cqi'
  | 'latency_p95_ms'
  | 'packet_loss_pct'
  | 'cpu_load_pct'
  | 'ho_fail_rate'

const COLUMNS: { key: SortKey; label: string; digits: number; unit?: string }[] = [
  { key: 'cell_id', label: 'Cell', digits: 0 },
  { key: 'prb_util', label: 'PRB', digits: 1, unit: '%' },
  { key: 'throughput_mbps', label: 'Throughput', digits: 0, unit: 'Mb/s' },
  { key: 'sinr_db', label: 'SINR', digits: 1, unit: 'dB' },
  { key: 'cqi', label: 'CQI', digits: 0 },
  { key: 'latency_p95_ms', label: 'Latency p95', digits: 1, unit: 'ms' },
  { key: 'packet_loss_pct', label: 'Loss', digits: 2, unit: '%' },
  { key: 'cpu_load_pct', label: 'CPU', digits: 0, unit: '%' },
  { key: 'ho_fail_rate', label: 'HO fail', digits: 1, unit: '%' },
]

function levelFor(key: SortKey, kpi: CellKPI) {
  switch (key) {
    case 'prb_util':
      return KPI_LEVEL.prb_util(kpi.prb_util)
    case 'latency_p95_ms':
      return KPI_LEVEL.latency_p95_ms(kpi.latency_p95_ms)
    case 'packet_loss_pct':
      return KPI_LEVEL.packet_loss_pct(kpi.packet_loss_pct)
    case 'cpu_load_pct':
      return KPI_LEVEL.cpu_load_pct(kpi.cpu_load_pct)
    case 'ho_fail_rate':
      return KPI_LEVEL.ho_fail_rate(kpi.ho_fail_rate)
    case 'sinr_db':
      return KPI_LEVEL.sinr_db(kpi.sinr_db)
    case 'cqi':
      return KPI_LEVEL.cqi(kpi.cqi)
    default:
      return undefined
  }
}

export function CellsPage() {
  const { frame } = useTelemetry()
  const latest = useLatestKpis()
  const navigate = useNavigate()
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'prb_util',
    dir: 'desc',
  })

  const rows = useMemo(() => {
    const list = Object.values(latest)
    return list.sort((a, b) => {
      const av = a[sort.key]
      const bv = b[sort.key]
      const cmp =
        typeof av === 'string' || typeof bv === 'string'
          ? String(av).localeCompare(String(bv))
          : Number(av) - Number(bv)
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [latest, sort])

  const toggle = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'cell_id' ? 'asc' : 'desc' },
    )

  return (
    <Panel
      label="Cell Register"
      meta={`${rows.length} cells · sorted by ${sort.key}`}
      flush
      bodyClassName="overflow-x-auto"
    >
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line">
            {COLUMNS.map((col) => (
              <th key={col.key} className={col.key === 'cell_id' ? 'text-left' : 'text-right'}>
                <button
                  type="button"
                  className="label flex w-full items-center gap-1 px-3 py-2 hover:text-ink2"
                  style={{ justifyContent: col.key === 'cell_id' ? 'flex-start' : 'flex-end' }}
                  onClick={() => toggle(col.key)}
                >
                  {col.label}
                  {sort.key === col.key ? (
                    sort.dir === 'asc' ? (
                      <ArrowUp size={10} />
                    ) : (
                      <ArrowDown size={10} />
                    )
                  ) : null}
                </button>
              </th>
            ))}
            <th className="label px-3 py-2 text-right">Energy</th>
            <th className="label px-3 py-2 text-right">Backhaul</th>
            <th className="label px-3 py-2 text-right">SLA</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((kpi) => {
            const link = frame?.backhaul?.[kpi.cell_id]
            return (
              <tr
                key={kpi.cell_id}
                className="row-hover cursor-pointer border-b border-line/60"
                onClick={() => navigate(`/cells/${kpi.cell_id}`)}
              >
                {COLUMNS.map((col) => {
                  if (col.key === 'cell_id') {
                    return (
                      <td key={col.key} className="px-3 py-1.5">
                        <span className="num flex items-center gap-2 text-[12px] text-ink">
                          <Led level={KPI_LEVEL.prb_util(kpi.prb_util)} size={6} />
                          {kpi.cell_id}
                        </span>
                      </td>
                    )
                  }
                  const raw =
                    col.key === 'ho_fail_rate'
                      ? kpi.ho_fail_rate * 100
                      : (kpi[col.key] as number)
                  const level = levelFor(col.key, kpi)
                  return (
                    <td key={col.key} className="px-3 py-1.5 text-right">
                      <span
                        className="num text-[12px]"
                        style={{ color: level ? LEVEL_HEX[level] : '#F0EAE0' }}
                      >
                        {num(raw, col.digits)}
                        {col.unit ? (
                          <span className="ml-0.5 text-[9px] text-ink3">{col.unit}</span>
                        ) : null}
                      </span>
                    </td>
                  )
                })}
                <td className="px-3 py-1.5 text-right">
                  <span
                    className="num text-[11px]"
                    style={{ color: LEVEL_HEX[energyLevel(kpi.energy_mode)] }}
                  >
                    {kpi.energy_mode}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right">
                  <span
                    className="num text-[11px]"
                    style={{ color: LEVEL_HEX[linkLevel(link?.status ?? 'UP')] }}
                  >
                    {link?.status ?? '—'}
                    <span className="ml-1 text-ink3">{num(link?.delay_ms, 0)}ms</span>
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right">
                  {kpi.sla_violation ? (
                    <span className="num text-[11px] text-coral">BREACH</span>
                  ) : (
                    <span className="num text-[11px] text-ink3">ok</span>
                  )}
                </td>
              </tr>
            )
          })}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={COLUMNS.length + 3} className="px-3 py-8 text-center">
                <span className="label">Waiting for the first KPI tick…</span>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {frame ? null : (
        <div className="border-t border-line px-3 py-2">
          <span className="label">No telemetry frame yet</span>
        </div>
      )}
    </Panel>
  )
}
