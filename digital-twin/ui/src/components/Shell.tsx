import { useMemo, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  Gauge,
  Grid3x3,
  Layers,
  Radio,
  Route,
} from 'lucide-react'
import { POLL_SLOW, twin } from '../api/twin'
import { useTelemetry } from '../api/telemetry'
import { Led } from './Led'
import { simClock } from '../lib/format'

const NAV = [
  { to: '/', label: 'Overview', icon: Gauge, end: true },
  { to: '/topology', label: 'Topology', icon: Grid3x3, end: false },
  { to: '/cells', label: 'Cells', icon: Radio, end: false },
  { to: '/slices', label: 'Slices', icon: Layers, end: false },
  { to: '/mobility', label: 'Mobility', icon: Route, end: false },
  { to: '/faults', label: 'Faults', icon: AlertTriangle, end: false },
  { to: '/what-if', label: 'What-If', icon: FlaskConical, end: false },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, end: false },
]

const TRANSPORT_COPY = {
  live: { text: 'WS LIVE', level: 'nominal' as const },
  polling: { text: 'REST POLL', level: 'elevated' as const },
  connecting: { text: 'LINKING', level: 'idle' as const },
  offline: { text: 'NO LINK', level: 'critical' as const },
}

export function Shell() {
  const [collapsed, setCollapsed] = useState(false)
  const { frame, transport, events } = useTelemetry()

  const health = useQuery({
    queryKey: ['health'],
    queryFn: twin.health,
    refetchInterval: POLL_SLOW,
  })

  const faults = useQuery({
    queryKey: ['faults'],
    queryFn: twin.faults,
    refetchInterval: POLL_SLOW,
  })

  const criticalCount = useMemo(
    () =>
      events.filter(
        (e) => ['HIGH', 'CRITICAL'].includes((e.severity ?? '').toUpperCase()),
      ).length,
    [events],
  )

  const link = TRANSPORT_COPY[transport]

  return (
    <div className="relative z-10 flex h-full">
      <nav
        className={`flex shrink-0 flex-col border-r border-line bg-panel transition-[width] duration-200 ${
          collapsed ? 'w-[56px]' : 'w-[188px]'
        }`}
      >
        <div className="flex h-12 items-center gap-2 border-b border-line px-3">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center border border-amber2 text-amber">
            <Activity size={12} strokeWidth={2.4} />
          </span>
          {!collapsed ? (
            <div className="min-w-0">
              <div className="num text-[12px] font-bold tracking-[0.22em] text-ink">ORION</div>
              <div className="label text-[9px] leading-none">Twin Console</div>
            </div>
          ) : null}
        </div>

        <ul className="flex-1 py-2">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                title={label}
                className={({ isActive }) =>
                  `relative flex items-center gap-2.5 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
                    isActive
                      ? 'bg-amberwash text-amber'
                      : 'text-ink3 hover:bg-raise hover:text-ink2'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive ? (
                      <span className="absolute left-0 top-0 h-full w-[2px] bg-amber" />
                    ) : null}
                    <Icon size={14} strokeWidth={1.8} className="shrink-0" />
                    {!collapsed ? <span className="truncate">{label}</span> : null}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>

        <div className="border-t border-line p-2">
          <button
            type="button"
            className="btn w-full px-2 py-1"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            {collapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
            {!collapsed ? <span>Collapse</span> : null}
          </button>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-panel px-4">
          <div className="flex items-center gap-2">
            <Led level={link.level} pulse={transport === 'live'} />
            <span className="num text-[10px] tracking-[0.14em] text-ink2">{link.text}</span>
          </div>

          <div className="hidden items-baseline gap-2 md:flex">
            <span className="label">Sim</span>
            <span className="num text-[13px] text-ink">{simClock(frame?.sim_time_s)}</span>
          </div>

          <div className="hidden items-baseline gap-2 lg:flex">
            <span className="label">Tick</span>
            <span className="num text-[13px] text-amber">{frame?.tick ?? '—'}</span>
            <span className="num text-[10px] text-ink3">
              /{health.data?.tick_interval_s ?? frame?.tick_interval_s ?? 5}s
            </span>
          </div>

          <div className="ml-auto flex items-center gap-4">
            {faults.data?.active ? (
              <NavLink
                to="/faults"
                className="num flex items-center gap-1.5 border border-coral/50 bg-coral/10 px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-coral"
              >
                <AlertTriangle size={12} />
                Fault active
              </NavLink>
            ) : null}

            {criticalCount > 0 ? (
              <div className="num flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-coral">
                <Led level="critical" pulse />
                {criticalCount} high
              </div>
            ) : null}

            <div className="hidden items-center gap-3 xl:flex">
              <span className="num flex items-center gap-1.5 text-[10px] tracking-[0.1em] text-ink3">
                <Led level={health.data?.kafka === 'connected' ? 'nominal' : 'idle'} size={6} />
                KAFKA
              </span>
              <span className="num flex items-center gap-1.5 text-[10px] tracking-[0.1em] text-ink3">
                <Led level={health.data?.influxdb === 'connected' ? 'nominal' : 'idle'} size={6} />
                INFLUX
              </span>
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto p-4">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
