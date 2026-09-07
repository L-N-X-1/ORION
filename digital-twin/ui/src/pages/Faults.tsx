import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Bot, RotateCcw } from 'lucide-react'
import { POLL_SLOW, twin } from '../api/twin'
import { useTelemetry } from '../api/telemetry'
import { Panel } from '../components/Panel'
import { Led, Tag } from '../components/Led'
import { EventFeed } from '../components/EventFeed'
import { useToast } from '../components/Toaster'
import { int, num, titleise } from '../lib/format'

interface ParamSpec {
  name: string
  label: string
  kind: 'number' | 'cells' | 'text'
  initial: string
  /** Also sent on the restore call. */
  restore?: boolean
}

interface ScenarioDef {
  id: string
  title: string
  blurb: string
  /** FaultInjector method name for /fault/inject. */
  inject: string
  /** Suffix for restore_<name> on /fault/restore. */
  restore: string
  params: ParamSpec[]
}

const SCENARIOS: ScenarioDef[] = [
  {
    id: 'evening_congestion',
    title: 'Evening Congestion',
    blurb: 'Pins three adjacent cells to 98% offered load until restored.',
    inject: 'evening_congestion',
    restore: 'evening_congestion',
    params: [
      { name: 'cells', label: 'cells (comma separated)', kind: 'cells', initial: '', restore: true },
    ],
  },
  {
    id: 'backhaul_degradation',
    title: 'Backhaul Degradation',
    blurb: 'Raises transport delay and loss on one cell, tripping the backhaul event rule.',
    inject: 'backhaul_degradation',
    restore: 'backhaul',
    params: [
      { name: 'cell_id', label: 'cell', kind: 'text', initial: 'C00', restore: true },
      { name: 'delay_ms', label: 'delay ms', kind: 'number', initial: '150' },
      { name: 'loss_pct', label: 'loss %', kind: 'number', initial: '5' },
    ],
  },
  {
    id: 'mobility_storm',
    title: 'Mobility Storm',
    blurb: 'Drops the A3 offset near zero so handovers trigger far below the load threshold.',
    inject: 'mobility_storm',
    restore: 'handover_params',
    params: [
      { name: 'cell_id', label: 'cell', kind: 'text', initial: 'C11', restore: true },
      { name: 'a3_offset', label: 'A3 offset dB', kind: 'number', initial: '0.1' },
    ],
  },
  {
    id: 'policy_misconfiguration',
    title: 'Policy Misconfiguration',
    blurb: 'Inverts slice priorities so IoT outranks premium traffic.',
    inject: 'policy_misconfiguration',
    restore: 'slice_priorities',
    params: [],
  },
  {
    id: 'energy_saving_failure',
    title: 'Energy Saving Failure',
    blurb: 'Forces SLEEP mode during peak load, cutting effective PRB to 30%.',
    inject: 'energy_saving_failure',
    restore: 'energy_mode',
    params: [{ name: 'cell_id', label: 'cell', kind: 'text', initial: 'C20', restore: true }],
  },
]

function buildParams(spec: ScenarioDef, values: Record<string, string>, restoreOnly: boolean) {
  const out: Record<string, unknown> = {}
  for (const p of spec.params) {
    if (restoreOnly && !p.restore) continue
    const raw = (values[p.name] ?? '').trim()
    if (raw === '') continue
    if (p.kind === 'number') out[p.name] = Number(raw)
    else if (p.kind === 'cells') out[p.name] = raw.split(',').map((s) => s.trim()).filter(Boolean)
    else out[p.name] = raw
  }
  return out
}

function ScenarioCard({ spec }: { spec: ScenarioDef }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(spec.params.map((p) => [p.name, p.initial])),
  )

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['faults'] })
    void qc.invalidateQueries({ queryKey: ['changes'] })
  }

  const inject = useMutation({
    mutationFn: () => twin.injectFault(spec.inject, buildParams(spec, values, false)),
    onSuccess: () => {
      toast.warn(`${spec.title} injected`, 'Watch the event stream for the twin reacting.')
      invalidate()
    },
    onError: (err: Error) => toast.fail(`${spec.title} failed`, err.message),
  })

  const restore = useMutation({
    mutationFn: () => twin.restoreFault(spec.restore, buildParams(spec, values, true)),
    onSuccess: () => {
      toast.ok(`${spec.title} restored`)
      invalidate()
    },
    onError: (err: Error) => toast.fail(`${spec.title} restore failed`, err.message),
  })

  const busy = inject.isPending || restore.isPending

  return (
    <div className="panel panel-ticks flex flex-col p-3">
      <div className="flex items-center gap-2">
        <AlertTriangle size={13} className="shrink-0 text-amber" />
        <h3 className="num text-[12px] tracking-[0.08em] text-ink">{spec.title}</h3>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-ink3">{spec.blurb}</p>

      {spec.params.length ? (
        <div className="mt-2.5 grid grid-cols-2 gap-2">
          {spec.params.map((p) => (
            <label key={p.name} className="flex flex-col gap-1">
              <span className="num text-[10px] text-ink3">{p.label}</span>
              <input
                className="field"
                type={p.kind === 'number' ? 'number' : 'text'}
                value={values[p.name] ?? ''}
                placeholder={p.kind === 'cells' ? 'defaults' : undefined}
                onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      ) : null}

      <div className="mt-auto flex gap-2 pt-3">
        <button
          type="button"
          className="btn btn-danger flex-1"
          disabled={busy}
          onClick={() => inject.mutate()}
        >
          Inject
        </button>
        <button
          type="button"
          className="btn flex-1"
          disabled={busy}
          onClick={() => restore.mutate()}
        >
          <RotateCcw size={11} />
          Restore
        </button>
      </div>
    </div>
  )
}

export function FaultsPage() {
  const toast = useToast()
  const qc = useQueryClient()
  const { events } = useTelemetry()
  const [agentCells, setAgentCells] = useState('')

  const faults = useQuery({
    queryKey: ['faults'],
    queryFn: twin.faults,
    refetchInterval: POLL_SLOW,
  })
  const changes = useQuery({
    queryKey: ['changes'],
    queryFn: twin.changes,
    refetchInterval: POLL_SLOW,
  })

  const rollback = useMutation({
    mutationFn: (changeId: string) => twin.rollback(changeId),
    onSuccess: (res) => {
      toast.ok(`Rolled back ${res.rolled_back}`)
      void qc.invalidateQueries({ queryKey: ['changes'] })
      void qc.invalidateQueries({ queryKey: ['faults'] })
    },
    onError: (err: Error) => toast.fail('Rollback failed', err.message),
  })

  const agentFault = useMutation({
    mutationFn: () => {
      const cells = agentCells
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      return twin.injectAgentFault('evening_congestion', cells.length ? cells : undefined)
    },
    onSuccess: (res) => {
      toast.warn('Agent pipeline fired', `${res.event_id} · ${res.incident_id}`)
      void qc.invalidateQueries({ queryKey: ['faults'] })
    },
    onError: (err: Error) => toast.fail('Agent fault failed', err.message),
  })

  const agentRestore = useMutation({
    mutationFn: () => twin.restoreAgentFault('evening_congestion'),
    onSuccess: () => {
      toast.ok('Ephemeral agent fault cleared')
      void qc.invalidateQueries({ queryKey: ['faults'] })
    },
    onError: (err: Error) => toast.fail('Agent restore failed', err.message),
  })

  const surface = faults.data
  const activeRows = useMemo(() => {
    if (!surface) return []
    const rows: { kind: string; target: string; detail: string; level: 'critical' | 'elevated' }[] =
      []
    for (const [cellId, load] of Object.entries(surface.pinned_loads)) {
      rows.push({
        kind: 'Pinned load',
        target: cellId,
        detail: `offered load locked at ${num(load * 100, 0)}%`,
        level: 'critical',
      })
    }
    for (const [name, sf] of Object.entries(surface.synthetic_faults)) {
      rows.push({
        kind: 'Synthetic',
        target: (sf.cells ?? []).join(' ') || '—',
        detail: `${titleise(name)} · PRB override ${num((sf.prb_override ?? 0) * 100, 0)}%`,
        level: 'critical',
      })
    }
    for (const link of surface.degraded_backhaul) {
      rows.push({
        kind: 'Backhaul',
        target: link.cell_id,
        detail: `${link.status} · ${num(link.delay_ms, 0)} ms · ${num(link.loss_pct, 2)}% loss`,
        level: 'elevated',
      })
    }
    for (const c of surface.non_active_cells) {
      rows.push({
        kind: 'Energy mode',
        target: c.cell_id,
        detail: c.energy_mode,
        level: c.energy_mode === 'SHUTDOWN' ? 'critical' : 'elevated',
      })
    }
    for (const h of surface.handover_anomalies) {
      rows.push({
        kind: 'Handover',
        target: h.cell_id,
        detail: `A3 ${num(h.a3_offset, 2)} dB · TTT ${num(h.ttt_ms, 0)} ms`,
        level: 'critical',
      })
    }
    if (surface.slice_priority_inverted) {
      rows.push({
        kind: 'Slice policy',
        target: 'slice-premium',
        detail: 'Priority inverted — IoT outranks premium',
        level: 'critical',
      })
    }
    return rows
  }, [surface])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 xl:flex-row">
        <Panel
          label="Active Deviations"
          meta={surface ? (surface.active ? `${activeRows.length} open` : 'baseline') : 'loading'}
          className="min-w-0 flex-1"
          flush
        >
          {activeRows.length === 0 ? (
            <div className="flex h-[140px] flex-col items-center justify-center gap-1.5">
              <Led level="nominal" />
              <span className="label">Network at nominal baseline</span>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {activeRows.map((row, i) => (
                <li key={`${row.kind}-${row.target}-${i}`} className="flex items-center gap-3 px-3 py-2">
                  <Led level={row.level} pulse={row.level === 'critical'} />
                  <span className="num w-[104px] shrink-0 text-[11px] text-ink2">{row.kind}</span>
                  <Link
                    to={`/cells/${row.target.split(' ')[0]}`}
                    className="num w-[80px] shrink-0 text-[11px] text-ink hover:text-amber"
                  >
                    {row.target}
                  </Link>
                  <span className="truncate text-[11px] text-ink3">{row.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel label="Agent Hand-off" className="xl:w-[340px] xl:shrink-0">
          <div className="flex flex-col gap-2.5">
            <p className="text-[11px] leading-snug text-ink3">
              Injects an ephemeral congestion fault and posts a NetworkEvent straight to the
              LangGraph pipeline at <span className="num text-ink2">AGENT_URL</span>. It only
              completes when the agentic-ai stack is reachable from this one.
            </p>
            <label className="flex flex-col gap-1">
              <span className="num text-[10px] text-ink3">target cells (optional)</span>
              <input
                className="field"
                value={agentCells}
                placeholder="C00, C01, C10"
                onChange={(e) => setAgentCells(e.target.value)}
              />
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-primary flex-1"
                disabled={agentFault.isPending}
                onClick={() => agentFault.mutate()}
              >
                <Bot size={12} />
                Fire pipeline
              </button>
              <button
                type="button"
                className="btn flex-1"
                disabled={agentRestore.isPending}
                onClick={() => agentRestore.mutate()}
              >
                Clear
              </button>
            </div>
          </div>
        </Panel>
      </div>

      <div>
        <div className="label mb-2">Scenario Library</div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {SCENARIOS.map((s) => (
            <ScenarioCard key={s.id} spec={s} />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 xl:flex-row">
        <Panel
          label="Change Log"
          meta={`${int(changes.data?.count)} records`}
          className="min-w-0 flex-1"
          flush
          bodyClassName="overflow-y-auto max-h-[320px]"
        >
          {(changes.data?.changes.length ?? 0) === 0 ? (
            <div className="px-3 py-8 text-center">
              <span className="label">No changes applied yet</span>
            </div>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line">
                  {['Change', 'Type', 'Target', 'Previous', 'Sim', ''].map((h, i) => (
                    <th
                      key={h || i}
                      className={`label px-3 py-2 ${i === 0 ? 'text-left' : 'text-left'}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(changes.data?.changes ?? []).map((c) => (
                  <tr key={c.change_id} className="row-hover border-b border-line/60">
                    <td className="px-3 py-1.5">
                      <Tag level="elevated">{c.change_id}</Tag>
                    </td>
                    <td className="num px-3 py-1.5 text-[11px] text-ink2">{c.type}</td>
                    <td className="num px-3 py-1.5 text-[11px] text-ink">
                      {c.cell_id ??
                        (c.params as { slice_id?: string } | undefined)?.slice_id ??
                        '—'}
                    </td>
                    <td className="num max-w-[240px] truncate px-3 py-1.5 text-[10px] text-ink3">
                      {c.previous ? JSON.stringify(c.previous) : '—'}
                    </td>
                    <td className="num px-3 py-1.5 text-[10px] text-ink3">
                      {Math.round(c.sim_time_s)}s
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        type="button"
                        className="btn px-2 py-1"
                        disabled={rollback.isPending}
                        onClick={() => rollback.mutate(c.change_id)}
                      >
                        <RotateCcw size={11} />
                        Roll back
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          label="Event Stream"
          meta={`${events.length}`}
          className="xl:w-[340px] xl:shrink-0"
          bodyClassName="overflow-y-auto max-h-[320px]"
          flush
        >
          <EventFeed events={events} limit={40} />
        </Panel>
      </div>
    </div>
  )
}
