import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { NetworkEvent } from '../api/types'
import { LEVEL_HEX, severityLevel } from '../lib/status'
import { clockTime, relativeTime, titleise } from '../lib/format'
import { Led } from './Led'

interface EventFeedProps {
  events: NetworkEvent[]
  limit?: number
  linkEntities?: boolean
}

export function EventFeed({ events, limit = 40, linkEntities = true }: EventFeedProps) {
  const [openId, setOpenId] = useState<string | null>(null)
  const shown = events.slice(0, limit)

  if (shown.length === 0) {
    return (
      <div className="flex h-full min-h-[120px] items-center justify-center">
        <span className="label">No events — network nominal</span>
      </div>
    )
  }

  return (
    <ul className="divide-y divide-line">
      {shown.map((ev) => {
        const level = severityLevel(ev.severity)
        const open = openId === ev.event_id
        return (
          <li key={ev.event_id} className="row-hover">
            <button
              type="button"
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
              onClick={() => setOpenId(open ? null : ev.event_id)}
            >
              <Led level={level} pulse={level === 'critical'} />
              <span
                className="num w-[132px] shrink-0 truncate text-[11px]"
                style={{ color: LEVEL_HEX[level] }}
              >
                {ev.event_type}
              </span>
              {linkEntities ? (
                <Link
                  to={`/cells/${ev.entity_id}`}
                  className="num shrink-0 text-[11px] text-ink underline decoration-line2 underline-offset-2 hover:decoration-amber"
                  onClick={(e) => e.stopPropagation()}
                >
                  {ev.entity_id}
                </Link>
              ) : (
                <span className="num shrink-0 text-[11px] text-ink">{ev.entity_id}</span>
              )}
              <span className="num ml-auto shrink-0 text-[10px] text-ink3">
                {relativeTime(ev.ts)}
              </span>
            </button>
            {open ? (
              <div className="border-t border-line bg-void px-3 py-2">
                <div className="label mb-1.5">
                  Evidence · {clockTime(ev.ts)} · sim {Math.round(ev.sim_time_s)}s
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                  {Object.entries(ev.evidence ?? {}).map(([k, v]) => (
                    <div key={k} className="flex items-baseline justify-between gap-2">
                      <dt className="truncate text-[11px] text-ink3">{titleise(k)}</dt>
                      <dd className="num shrink-0 text-[11px] text-ink">{String(v)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
