import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import { useLatestKpis, useTelemetry } from '../api/telemetry'
import { LAYERS, TopologyCanvas } from '../components/TopologyCanvas'
import type { LayerId } from '../components/TopologyCanvas'
import { CellActions } from '../components/CellActions'
import { EventFeed } from '../components/EventFeed'
import { Panel } from '../components/Panel'
import { Field } from '../components/Stat'
import { Led, Tag } from '../components/Led'
import { KPI_LEVEL, energyLevel, linkLevel } from '../lib/status'
import { num, pct } from '../lib/format'

export function TopologyPage() {
  const { frame, events, cellIds } = useTelemetry()
  const latest = useLatestKpis()
  const [layer, setLayer] = useState<LayerId>('load')
  const [selected, setSelected] = useState<string | null>(null)

  const cells = frame?.cells ?? {}
  const backhaul = frame?.backhaul ?? {}
  const cell = selected ? cells[selected] : undefined
  const kpi = selected ? latest[selected] : undefined
  const link = selected ? backhaul[selected] : undefined

  const cellEvents = useMemo(
    () => (selected ? events.filter((e) => e.entity_id === selected) : []),
    [events, selected],
  )

  return (
    <div className="flex h-[calc(100vh-104px)] min-h-[560px] flex-col gap-3 xl:flex-row">
      <Panel
        label="RAN Topology"
        meta={`${cellIds.length} cells · ${Object.keys(backhaul).length} backhaul links`}
        className="min-h-[420px] flex-1"
        flush
        actions={
          <div className="flex flex-wrap items-center gap-1">
            {LAYERS.map((l) => (
              <button
                key={l.id}
                type="button"
                className={`btn px-2 py-1 ${layer === l.id ? 'btn-primary' : ''}`}
                onClick={() => setLayer(l.id)}
              >
                {l.label}
              </button>
            ))}
          </div>
        }
      >
        <TopologyCanvas
          cells={cells}
          backhaul={backhaul}
          kpis={latest}
          layer={layer}
          selected={selected}
          onSelect={setSelected}
        />
      </Panel>

      <div className="flex w-full flex-col gap-3 xl:w-[352px] xl:shrink-0">
        <Panel
          label={selected ? `Inspector · ${selected}` : 'Inspector'}
          meta={selected ? undefined : 'click a cell'}
          actions={
            selected ? (
              <Link to={`/cells/${selected}`} className="btn px-2 py-1">
                Detail
                <ExternalLink size={11} />
              </Link>
            ) : null
          }
          className="shrink-0"
        >
          {!selected || !cell ? (
            <div className="flex h-[180px] flex-col items-center justify-center gap-2 text-center">
              <span className="label">No cell selected</span>
              <p className="max-w-[240px] text-[11px] leading-snug text-ink3">
                Click a hexagon to inspect its live KPIs, neighbours and backhaul, or to act on
                it directly. Scroll to zoom, drag to pan.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <Tag level={energyLevel(cell.energy_mode)}>{cell.energy_mode}</Tag>
                <Tag level={linkLevel(link?.status ?? 'UP')}>BH {link?.status ?? '—'}</Tag>
                {kpi?.sla_violation ? <Tag level="critical">SLA breach</Tag> : null}
                {kpi?.is_peak ? <Tag level="elevated">Peak hour</Tag> : null}
              </div>

              <div className="grid grid-cols-3 gap-y-3">
                <Field
                  label="PRB"
                  value={num(kpi?.prb_util, 1)}
                  unit="%"
                  level={kpi ? KPI_LEVEL.prb_util(kpi.prb_util) : undefined}
                />
                <Field
                  label="Throughput"
                  value={num(kpi?.throughput_mbps, 0)}
                  unit="Mb/s"
                />
                <Field
                  label="Latency"
                  value={num(kpi?.latency_p95_ms, 0)}
                  unit="ms"
                  level={kpi ? KPI_LEVEL.latency_p95_ms(kpi.latency_p95_ms) : undefined}
                />
                <Field
                  label="SINR"
                  value={num(kpi?.sinr_db, 1)}
                  unit="dB"
                  level={kpi ? KPI_LEVEL.sinr_db(kpi.sinr_db) : undefined}
                />
                <Field label="CQI" value={kpi?.cqi ?? '—'} />
                <Field
                  label="Loss"
                  value={num(kpi?.packet_loss_pct, 2)}
                  unit="%"
                  level={kpi ? KPI_LEVEL.packet_loss_pct(kpi.packet_loss_pct) : undefined}
                />
                <Field label="CPU" value={num(kpi?.cpu_load_pct, 0)} unit="%" />
                <Field
                  label="HO fail"
                  value={pct((kpi?.ho_fail_rate ?? 0) * 100, 1)}
                  level={kpi ? KPI_LEVEL.ho_fail_rate(kpi.ho_fail_rate) : undefined}
                />
                <Field label="Eff. PRB" value={cell.effective_prb} unit={`/ ${cell.max_prb}`} />
              </div>

              <div>
                <div className="label mb-1.5">Neighbours</div>
                <div className="flex flex-wrap gap-1.5">
                  {cell.neighbours.map((nb) => {
                    const nk = latest[nb]
                    return (
                      <button
                        key={nb}
                        type="button"
                        className="btn px-2 py-1"
                        onClick={() => setSelected(nb)}
                      >
                        <Led
                          level={nk ? KPI_LEVEL.prb_util(nk.prb_util) : 'idle'}
                          size={5}
                        />
                        {nb}
                        <span className="text-ink3">{num(nk?.prb_util, 0)}%</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <div className="label mb-1.5">Backhaul</div>
                <div className="grid grid-cols-3 gap-y-2">
                  <Field label="Delay" value={num(link?.delay_ms, 1)} unit="ms" />
                  <Field label="Loss" value={num(link?.loss_pct, 2)} unit="%" />
                  <Field
                    label="Status"
                    value={link?.status ?? '—'}
                    level={linkLevel(link?.status ?? 'UP')}
                  />
                </div>
              </div>

              <div className="border-t border-line pt-3">
                <CellActions cell={cell} compact />
              </div>
            </div>
          )}
        </Panel>

        <Panel
          label={selected ? `Events · ${selected}` : 'Events'}
          meta={selected ? `${cellEvents.length}` : `${events.length}`}
          className="min-h-[160px] flex-1"
          bodyClassName="overflow-y-auto"
          flush
        >
          <EventFeed events={selected ? cellEvents : events} limit={30} />
        </Panel>
      </div>
    </div>
  )
}
