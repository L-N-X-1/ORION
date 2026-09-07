import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { telemetrySocketUrl, twin } from './twin'
import type { CellKPI, NetworkEvent, TelemetryFrame } from './types'

const HISTORY_LIMIT = 240
const EVENT_LIMIT = 200
const WS_RETRY_MS = 8_000
const POLL_MS = 5_000

export type Transport = 'connecting' | 'live' | 'polling' | 'offline'

export interface TelemetryValue {
  frame: TelemetryFrame | null
  history: Record<string, CellKPI[]>
  events: NetworkEvent[]
  transport: Transport
  lastUpdate: number | null
  cellIds: string[]
  /** Bumped on every ingested frame so consumers can memoise cheaply. */
  revision: number
}

const EMPTY: TelemetryValue = {
  frame: null,
  history: {},
  events: [],
  transport: 'connecting',
  lastUpdate: null,
  cellIds: [],
  revision: 0,
}

const TelemetryContext = createContext<TelemetryValue>(EMPTY)

function pushKpi(buf: CellKPI[], kpi: CellKPI): void {
  const last = buf[buf.length - 1]
  if (last && last.tick === kpi.tick) {
    // Same tick re-sent (live-patched load / PRB) — replace in place.
    buf[buf.length - 1] = kpi
    return
  }
  buf.push(kpi)
  if (buf.length > HISTORY_LIMIT) buf.splice(0, buf.length - HISTORY_LIMIT)
}

export function TelemetryProvider({ children }: { children: ReactNode }) {
  const historyRef = useRef<Record<string, CellKPI[]>>({})
  const eventIdsRef = useRef<Set<string>>(new Set())
  const eventsRef = useRef<NetworkEvent[]>([])
  const revisionRef = useRef(0)
  const [value, setValue] = useState<TelemetryValue>(EMPTY)

  const ingest = useCallback((frame: TelemetryFrame, transport: Transport) => {
    for (const kpi of frame.kpis ?? []) {
      const buf = historyRef.current[kpi.cell_id] ?? []
      pushKpi(buf, kpi)
      historyRef.current[kpi.cell_id] = buf
    }

    let eventsChanged = false
    for (const ev of frame.events ?? []) {
      if (eventIdsRef.current.has(ev.event_id)) continue
      eventIdsRef.current.add(ev.event_id)
      eventsRef.current.unshift(ev)
      eventsChanged = true
    }
    if (eventsChanged && eventsRef.current.length > EVENT_LIMIT) {
      for (const dropped of eventsRef.current.splice(EVENT_LIMIT)) {
        eventIdsRef.current.delete(dropped.event_id)
      }
    }

    revisionRef.current += 1
    setValue({
      frame,
      history: { ...historyRef.current },
      events: eventsChanged ? [...eventsRef.current] : eventsRef.current,
      transport,
      lastUpdate: Date.now(),
      cellIds: Object.keys(frame.cells ?? {}).sort(),
      revision: revisionRef.current,
    })
  }, [])

  const setTransport = useCallback((transport: Transport) => {
    setValue((prev) => (prev.transport === transport ? prev : { ...prev, transport }))
  }, [])

  // Seed per-cell history once so charts are not empty on first paint.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const topo = await twin.topology()
        const ids = Object.keys(topo.cells)
        const results = await Promise.all(
          ids.map((id) => twin.cellMetrics(id, 60).catch(() => null)),
        )
        if (cancelled) return
        for (const res of results) {
          if (!res) continue
          const buf = historyRef.current[res.cell_id] ?? []
          for (const kpi of res.kpis) pushKpi(buf, kpi)
          historyRef.current[res.cell_id] = buf
        }
        revisionRef.current += 1
        setValue((prev) => ({
          ...prev,
          history: { ...historyRef.current },
          cellIds: prev.cellIds.length ? prev.cellIds : ids.slice().sort(),
          revision: revisionRef.current,
        }))
      } catch {
        /* twin not up yet — the socket/poller will fill in */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // WebSocket with a REST polling fallback.
  useEffect(() => {
    let disposed = false
    let socket: WebSocket | null = null
    let retryTimer: number | undefined
    let pollTimer: number | undefined

    const stopPolling = () => {
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer)
        pollTimer = undefined
      }
    }

    const pollOnce = async () => {
      try {
        const [metrics, events, topo] = await Promise.all([
          twin.metrics(),
          twin.events(30),
          twin.topology(),
        ])
        if (disposed) return
        const latest = metrics.kpis[0]
        ingest(
          {
            type: 'tick',
            tick: latest ? latest.tick : 0,
            sim_time_s: latest ? latest.sim_time_s : 0,
            tick_interval_s: 5,
            ts: new Date().toISOString(),
            kpis: metrics.kpis,
            cells: topo.cells,
            slices: topo.slices,
            backhaul: topo.backhaul,
            events: events.events,
            pinned_loads: metrics.pinned_loads,
            synthetic_faults: {},
          },
          'polling',
        )
      } catch {
        if (!disposed) setTransport('offline')
      }
    }

    const startPolling = () => {
      if (pollTimer !== undefined) return
      setTransport('polling')
      void pollOnce()
      pollTimer = window.setInterval(() => void pollOnce(), POLL_MS)
    }

    const connect = () => {
      if (disposed) return
      try {
        socket = new WebSocket(telemetrySocketUrl())
      } catch {
        startPolling()
        retryTimer = window.setTimeout(connect, WS_RETRY_MS)
        return
      }

      socket.onopen = () => {
        stopPolling()
        setTransport('live')
      }

      socket.onmessage = (msg) => {
        try {
          const frame = JSON.parse(msg.data as string) as TelemetryFrame
          if (frame.type === 'heartbeat') {
            setTransport('live')
            return
          }
          ingest(frame, 'live')
        } catch {
          /* malformed frame — drop it, the next tick will resync */
        }
      }

      socket.onerror = () => {
        socket?.close()
      }

      socket.onclose = () => {
        if (disposed) return
        socket = null
        startPolling()
        retryTimer = window.setTimeout(connect, WS_RETRY_MS)
      }
    }

    connect()

    return () => {
      disposed = true
      stopPolling()
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      if (socket) {
        socket.onclose = null
        socket.close()
      }
    }
  }, [ingest, setTransport])

  return <TelemetryContext.Provider value={value}>{children}</TelemetryContext.Provider>
}

export function useTelemetry(): TelemetryValue {
  return useContext(TelemetryContext)
}

/**
 * Latest KPI per cell, keyed by cell id. Falls back to the tail of the seeded
 * history so the first paint is populated before the first socket frame lands.
 */
export function useLatestKpis(): Record<string, CellKPI> {
  const { frame, history } = useTelemetry()
  return useMemo(() => {
    const out: Record<string, CellKPI> = {}
    for (const [cellId, buf] of Object.entries(history)) {
      const last = buf[buf.length - 1]
      if (last) out[cellId] = last
    }
    for (const kpi of frame?.kpis ?? []) out[kpi.cell_id] = kpi
    return out
  }, [frame, history])
}
