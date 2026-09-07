import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, RefreshCw, Settings2 } from 'lucide-react'
import { grafanaBaseUrl, setGrafanaBaseUrl } from '../api/twin'
import { Panel } from '../components/Panel'

/**
 * Grafana owns history and long-range analysis; this console owns live state
 * and control. The panel list is read from Grafana at runtime rather than
 * hardcoded, so a panel added to the dashboard shows up here without a
 * front-end change. DASHBOARD_FALLBACK mirrors
 * digital-twin/grafana/provisioning/dashboards/cell_kpi_overview.json and is
 * only used when the API cannot be reached.
 */
const DASHBOARD_UID = 'digital-twin-cell-kpi'
const DASHBOARD_SLUG = 'digital-twin-cell-kpi-overview'

interface GrafanaPanel {
  id: number
  title: string
  type: string
  gridPos: { x: number; y: number; w: number; h: number }
}

const DASHBOARD_FALLBACK: GrafanaPanel[] = [
  { id: 1, title: 'Active Cells', type: 'stat', gridPos: { x: 0, y: 0, w: 8, h: 4 } },
  { id: 2, title: 'Avg PRB Utilization', type: 'stat', gridPos: { x: 8, y: 0, w: 8, h: 4 } },
  { id: 3, title: 'SLA Violation Rate', type: 'stat', gridPos: { x: 16, y: 0, w: 8, h: 4 } },
  { id: 4, title: 'Throughput (Mbps)', type: 'timeseries', gridPos: { x: 0, y: 4, w: 12, h: 8 } },
  { id: 5, title: 'PRB Utilization (%)', type: 'timeseries', gridPos: { x: 12, y: 4, w: 12, h: 8 } },
  { id: 6, title: 'SINR (dB)', type: 'timeseries', gridPos: { x: 0, y: 12, w: 12, h: 8 } },
  { id: 7, title: 'CQI', type: 'timeseries', gridPos: { x: 12, y: 12, w: 12, h: 8 } },
  { id: 8, title: 'Latency p95 (ms)', type: 'timeseries', gridPos: { x: 0, y: 20, w: 12, h: 8 } },
  { id: 9, title: 'Packet Loss (%)', type: 'timeseries', gridPos: { x: 12, y: 20, w: 12, h: 8 } },
  { id: 10, title: 'CPU Load (%)', type: 'timeseries', gridPos: { x: 0, y: 28, w: 12, h: 8 } },
  { id: 11, title: 'Handover Failure Rate', type: 'timeseries', gridPos: { x: 12, y: 28, w: 12, h: 8 } },
  { id: 12, title: 'Cell Status (latest, energy mode)', type: 'table', gridPos: { x: 0, y: 36, w: 24, h: 8 } },
]

const RANGES = [
  { id: 'now-15m', label: '15m' },
  { id: 'now-1h', label: '1h' },
  { id: 'now-6h', label: '6h' },
  { id: 'now-24h', label: '24h' },
  { id: 'now-7d', label: '7d' },
]

/**
 * Grafana lays out on 24 columns; this page uses 6, so a panel's width maps
 * straight across (w 8 -> 2, w 12 -> 3, w 24 -> 6). The classes are written as
 * literals because Tailwind scans source text and would drop them if they were
 * assembled at runtime.
 */
const SPAN_CLASS: Record<number, string> = {
  1: 'xl:col-span-1',
  2: 'xl:col-span-2',
  3: 'xl:col-span-3',
  4: 'xl:col-span-4',
  5: 'xl:col-span-5',
  6: 'xl:col-span-6',
}

function spanFor(w: number): string {
  const cols = Math.min(6, Math.max(1, Math.round((w / 24) * 6)))
  return SPAN_CLASS[cols]
}

/** Grafana grid rows are 30px plus margin; this keeps embeds close to scale. */
function heightFor(h: number): number {
  return Math.max(140, h * 36)
}

export function AnalyticsPage() {
  const [base, setBase] = useState(grafanaBaseUrl())
  const [draft, setDraft] = useState(base)
  const [showSettings, setShowSettings] = useState(false)
  const [range, setRange] = useState('now-1h')
  const [mode, setMode] = useState<'panels' | 'dashboard'>('panels')
  const [nonce, setNonce] = useState(0)

  const dashboard = useQuery({
    queryKey: ['grafana-dashboard', base],
    queryFn: async (): Promise<GrafanaPanel[]> => {
      // Same-origin proxy first (nginx in the container, Vite in dev): Grafana
      // sends no CORS headers, so a direct cross-origin call is blocked by the
      // browser even though the iframes load from that same host fine.
      const candidates = [
        `/grafana/api/dashboards/uid/${DASHBOARD_UID}`,
        `${base}/api/dashboards/uid/${DASHBOARD_UID}`,
      ]
      let lastError = 'unreachable'
      for (const url of candidates) {
        try {
          const r = await fetch(url)
          if (!r.ok) {
            lastError = `${r.status} ${r.statusText}`
            continue
          }
          const body = (await r.json()) as { dashboard?: { panels?: GrafanaPanel[] } }
          const panels = body.dashboard?.panels
          if (panels?.length) return panels
          lastError = 'dashboard has no panels'
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
        }
      }
      throw new Error(lastError)
    },
    retry: 0,
    staleTime: 60_000,
  })

  const panels = useMemo(() => {
    const list = dashboard.data ?? DASHBOARD_FALLBACK
    return [...list].sort(
      (a, b) => a.gridPos.y - b.gridPos.y || a.gridPos.x - b.gridPos.x,
    )
  }, [dashboard.data])

  const dashboardSrc = useMemo(
    () =>
      `${base}/d/${DASHBOARD_UID}/${DASHBOARD_SLUG}?orgId=1&theme=dark&kiosk&from=${range}&to=now&refresh=10s&_n=${nonce}`,
    [base, range, nonce],
  )

  const panelSrc = (panelId: number) =>
    `${base}/d-solo/${DASHBOARD_UID}/${DASHBOARD_SLUG}?orgId=1&theme=dark&panelId=${panelId}&from=${range}&to=now&refresh=10s&_n=${nonce}`

  const sourceNote = dashboard.isLoading
    ? 'reading panel list…'
    : dashboard.isError
      ? `${panels.length} panels · offline list`
      : `${panels.length} panels · live from Grafana`

  return (
    <div className="flex flex-col gap-3">
      <Panel
        label="Observability · Grafana"
        meta={`${base.replace(/^https?:\/\//, '')} · ${sourceNote}`}
        actions={
          <div className="flex flex-wrap items-center gap-1">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`btn px-2 py-1 ${range === r.id ? 'btn-primary' : ''}`}
                onClick={() => setRange(r.id)}
              >
                {r.label}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-line2" />
            <button
              type="button"
              className={`btn px-2 py-1 ${mode === 'panels' ? 'btn-primary' : ''}`}
              onClick={() => setMode('panels')}
            >
              Panels
            </button>
            <button
              type="button"
              className={`btn px-2 py-1 ${mode === 'dashboard' ? 'btn-primary' : ''}`}
              onClick={() => setMode('dashboard')}
            >
              Dashboard
            </button>
            <button
              type="button"
              className="btn px-2 py-1"
              onClick={() => {
                setNonce((n) => n + 1)
                void dashboard.refetch()
              }}
              aria-label="Reload embeds"
            >
              <RefreshCw size={11} />
            </button>
            <button
              type="button"
              className="btn px-2 py-1"
              onClick={() => setShowSettings((s) => !s)}
              aria-label="Grafana connection settings"
            >
              <Settings2 size={11} />
            </button>
            <a
              className="btn px-2 py-1"
              href={`${base}/d/${DASHBOARD_UID}/${DASHBOARD_SLUG}?orgId=1&from=${range}&to=now`}
              target="_blank"
              rel="noreferrer"
            >
              Open
              <ExternalLink size={11} />
            </a>
          </div>
        }
      >
        <p className="text-[11px] leading-snug text-ink3">
          This console shows the live world state and drives control actions. Grafana keeps the
          long-range view over the same KPIs written to InfluxDB every tick — they are two
          windows onto one twin, not competing dashboards.
        </p>

        {dashboard.isError ? (
          <p className="mt-2 text-[11px] leading-snug text-amber">
            Could not read the panel list from Grafana ({String(dashboard.error)}). Showing the
            panels this build knows about; anything added to the dashboard since will be missing
            here but still visible in Dashboard mode.
          </p>
        ) : null}

        {showSettings ? (
          <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
            <label className="flex min-w-[260px] flex-1 flex-col gap-1">
              <span className="num text-[10px] text-ink3">Grafana base URL</span>
              <input
                className="field"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="http://localhost:3001"
              />
            </label>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setGrafanaBaseUrl(draft)
                setBase(grafanaBaseUrl())
                setNonce((n) => n + 1)
              }}
            >
              Save
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setGrafanaBaseUrl('')
                const next = grafanaBaseUrl()
                setBase(next)
                setDraft(next)
                setNonce((n) => n + 1)
              }}
            >
              Reset
            </button>
            <p className="w-full text-[11px] leading-snug text-ink3">
              Embedding needs Grafana started with anonymous access and
              <span className="num text-ink2"> GF_SECURITY_ALLOW_EMBEDDING=true</span>. The twin
              stack&apos;s compose file sets both.
            </p>
          </div>
        ) : null}
      </Panel>

      {mode === 'dashboard' ? (
        <Panel
          label="Cell KPI Overview"
          meta={range}
          flush
          className="h-[calc(100vh-260px)] min-h-[520px]"
        >
          <iframe
            key={dashboardSrc}
            src={dashboardSrc}
            title="Grafana dashboard"
            className="h-full w-full border-0 bg-void"
          />
        </Panel>
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-6">
          {panels.map((p) => (
            // Bare frame rather than a titled Panel: the Grafana solo panel
            // renders its own heading, and wrapping it in one of ours printed
            // every title twice.
            <div
              key={p.id}
              className={`panel panel-ticks overflow-hidden ${spanFor(p.gridPos.w)}`}
              style={{ height: heightFor(p.gridPos.h) }}
            >
              <iframe
                key={`${p.id}-${nonce}-${range}`}
                src={panelSrc(p.id)}
                title={p.title}
                className="h-full w-full border-0 bg-void"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
