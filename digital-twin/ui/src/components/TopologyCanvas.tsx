import { useCallback, useMemo, useRef, useState } from 'react'
import type { Backhaul, Cell, CellKPI } from '../api/types'
import type { Level } from '../lib/status'
import {
  C,
  KPI_LEVEL,
  LEVEL_HEX,
  energyLevel,
  linkLevel,
  loadHex,
  withAlpha,
} from '../lib/status'
import { num } from '../lib/format'

export const LAYERS = [
  { id: 'load', label: 'PRB Load', unit: '%' },
  { id: 'latency', label: 'Latency p95', unit: 'ms' },
  { id: 'sinr', label: 'SINR', unit: 'dB' },
  { id: 'handover', label: 'HO Fail', unit: '%' },
  { id: 'energy', label: 'Energy Mode', unit: '' },
  { id: 'backhaul', label: 'Backhaul', unit: 'ms' },
] as const

export type LayerId = (typeof LAYERS)[number]['id']

const R = 52
const HEX_W = Math.sqrt(3) * R
// Cells sit on a spaced grid rather than a tiled honeycomb: the twin's
// neighbour list is 4-connected, so leaving gaps lets every link render as a
// readable orthogonal segment instead of vanishing under an adjacent hex.
const COL_STEP = HEX_W + 26
const ROW_STEP = 2 * R + 24
const VIEW = { x: -106, y: -72, w: 560, h: 400 }

function hexPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = []
  for (let i = 0; i < 6; i += 1) {
    const a = (Math.PI / 180) * (30 + 60 * i)
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`)
  }
  return pts.join(' ')
}

/** C{row}{col} maps onto an offset hex grid; anything else falls back to a strip. */
function positionOf(cellId: string, index: number): { x: number; y: number } {
  const m = /^C(\d)(\d)$/.exec(cellId)
  const row = m ? Number(m[1]) : Math.floor(index / 4)
  const col = m ? Number(m[2]) : index % 4
  return { x: col * COL_STEP, y: row * ROW_STEP }
}

interface LayerReading {
  value: number | null
  text: string
  hex: string
  intensity: number
  level: Level
}

function readLayer(
  layer: LayerId,
  cell: Cell | undefined,
  kpi: CellKPI | undefined,
  link: Backhaul | undefined,
): LayerReading {
  switch (layer) {
    case 'latency': {
      const v = kpi?.latency_p95_ms ?? null
      const level = v === null ? 'idle' : KPI_LEVEL.latency_p95_ms(v)
      return {
        value: v,
        text: v === null ? '—' : num(v, 0),
        hex: LEVEL_HEX[level],
        intensity: v === null ? 0 : Math.min(1, v / 120),
        level,
      }
    }
    case 'sinr': {
      const v = kpi?.sinr_db ?? null
      const level = v === null ? 'idle' : KPI_LEVEL.sinr_db(v)
      return {
        value: v,
        text: v === null ? '—' : num(v, 1),
        hex: LEVEL_HEX[level],
        intensity: v === null ? 0 : Math.min(1, Math.max(0, (25 - v) / 30)),
        level,
      }
    }
    case 'handover': {
      const v = kpi?.ho_fail_rate ?? null
      const level = v === null ? 'idle' : KPI_LEVEL.ho_fail_rate(v)
      return {
        value: v,
        text: v === null ? '—' : num(v * 100, 1),
        hex: LEVEL_HEX[level],
        intensity: v === null ? 0 : Math.min(1, v / 0.4),
        level,
      }
    }
    case 'energy': {
      const mode = cell?.energy_mode ?? 'ACTIVE'
      const level = energyLevel(mode)
      return {
        value: null,
        text: mode.slice(0, 3),
        hex: LEVEL_HEX[level],
        intensity: mode === 'ACTIVE' ? 0.18 : 0.85,
        level,
      }
    }
    case 'backhaul': {
      const v = link?.delay_ms ?? null
      const level = linkLevel(link?.status ?? 'UP')
      return {
        value: v,
        text: v === null ? '—' : num(v, 0),
        hex: LEVEL_HEX[level],
        intensity: v === null ? 0 : Math.min(1, v / 200),
        level,
      }
    }
    case 'load':
    default: {
      const v = kpi?.prb_util ?? null
      const level = v === null ? 'idle' : KPI_LEVEL.prb_util(v)
      return {
        value: v,
        text: v === null ? '—' : num(v, 0),
        hex: v === null ? C.ink3 : loadHex(v),
        intensity: v === null ? 0 : Math.min(1, v / 100),
        level,
      }
    }
  }
}

interface TopologyCanvasProps {
  cells: Record<string, Cell>
  backhaul: Record<string, Backhaul>
  kpis: Record<string, CellKPI>
  layer: LayerId
  selected: string | null
  onSelect: (cellId: string) => void
  className?: string
}

export function TopologyCanvas({
  cells,
  backhaul,
  kpis,
  layer,
  selected,
  onSelect,
  className = '',
}: TopologyCanvasProps) {
  const [view, setView] = useState({ tx: 0, ty: 0, k: 1 })
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  // Set once a pointer travels past the slop threshold, so releasing after a
  // pan does not also select whatever hexagon happened to be under the cursor.
  const movedRef = useRef(false)

  const ids = useMemo(() => Object.keys(cells).sort(), [cells])
  const positions = useMemo(() => {
    const out: Record<string, { x: number; y: number }> = {}
    ids.forEach((id, i) => {
      out[id] = positionOf(id, i)
    })
    return out
  }, [ids])

  const edges = useMemo(() => {
    const seen = new Set<string>()
    const list: { a: string; b: string }[] = []
    for (const id of ids) {
      for (const nb of cells[id]?.neighbours ?? []) {
        if (!positions[nb]) continue
        const key = [id, nb].sort().join('|')
        if (seen.has(key)) continue
        seen.add(key)
        list.push({ a: id, b: nb })
      }
    }
    return list
  }, [ids, cells, positions])

  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault()
    setView((prev) => {
      const next = Math.max(0.55, Math.min(3, prev.k * (e.deltaY > 0 ? 0.9 : 1.1)))
      return { ...prev, k: next }
    })
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (e.button !== 0) return
      // Deliberately no setPointerCapture: capturing on the <svg> retargets the
      // subsequent click away from the hexagon group, which would make cells
      // unselectable.
      dragRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }
      movedRef.current = false
    },
    [view.tx, view.ty],
  )

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!movedRef.current && Math.hypot(dx, dy) < 4) return
    movedRef.current = true
    setView((prev) => ({ ...prev, tx: d.tx + dx, ty: d.ty + dy }))
  }, [])

  const endDrag = useCallback(() => {
    dragRef.current = null
  }, [])

  const selectIfNotDragging = useCallback(
    (cellId: string) => {
      if (movedRef.current) return
      onSelect(cellId)
    },
    [onSelect],
  )

  const reset = useCallback(() => setView({ tx: 0, ty: 0, k: 1 }), [])

  return (
    <div className={`relative h-full w-full overflow-hidden bg-void ${className}`}>
      <svg
        viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
        className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={endDrag}
      >
        <defs>
          <pattern id="tp-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M24 0 L0 0 0 24" fill="none" stroke={C.line} strokeWidth="0.5" opacity="0.5" />
          </pattern>
        </defs>
        <rect
          x={VIEW.x}
          y={VIEW.y}
          width={VIEW.w}
          height={VIEW.h}
          fill="url(#tp-grid)"
          opacity="0.6"
        />

        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
          {/* neighbour mesh */}
          <g>
            {edges.map(({ a, b }) => {
              const pa = positions[a]
              const pb = positions[b]
              const hot = Math.max(kpis[a]?.prb_util ?? 0, kpis[b]?.prb_util ?? 0)
              const stroke = hot > 90 ? C.coral : hot > 75 ? C.amber : C.line2
              return (
                <line
                  key={`${a}-${b}`}
                  x1={pa.x}
                  y1={pa.y}
                  x2={pb.x}
                  y2={pb.y}
                  stroke={stroke}
                  strokeWidth={hot > 75 ? 1.8 : 1.2}
                  opacity={hot > 75 ? 0.9 : 0.7}
                  strokeDasharray={hot > 90 ? '4 3' : undefined}
                />
              )
            })}
          </g>

          {/* cells */}
          {ids.map((id) => {
            const p = positions[id]
            const cell = cells[id]
            const kpi = kpis[id]
            const link = backhaul[id]
            const reading = readLayer(layer, cell, kpi, link)
            const isSelected = selected === id
            const sla = kpi?.sla_violation === true
            const linkHex = LEVEL_HEX[linkLevel(link?.status ?? 'UP')]

            return (
              <g
                key={id}
                role="button"
                tabIndex={0}
                aria-label={`Cell ${id}`}
                className="cursor-pointer outline-none"
                onClick={() => selectIfNotDragging(id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(id)
                  }
                }}
              >
                <polygon
                  points={hexPoints(p.x, p.y, R - 4)}
                  fill={withAlpha(reading.hex, 0.07 + reading.intensity * 0.26)}
                  stroke={isSelected ? C.amber : withAlpha(reading.hex, 0.6)}
                  strokeWidth={isSelected ? 2 : 1}
                />
                {isSelected ? (
                  <polygon
                    points={hexPoints(p.x, p.y, R + 3)}
                    fill="none"
                    stroke={withAlpha(C.amber, 0.35)}
                    strokeWidth={1}
                    strokeDasharray="3 4"
                  />
                ) : null}

                <text
                  x={p.x}
                  y={p.y - 20}
                  textAnchor="middle"
                  fontSize="11"
                  fontFamily="JetBrains Mono, monospace"
                  fontWeight="700"
                  letterSpacing="1.5"
                  fill={isSelected ? C.amber : C.ink2}
                >
                  {id}
                </text>

                <text
                  x={p.x}
                  y={p.y + 8}
                  textAnchor="middle"
                  fontSize="21"
                  fontFamily="JetBrains Mono, monospace"
                  fill={reading.hex}
                >
                  {reading.text}
                </text>

                {/* PRB rail — always visible regardless of the active layer */}
                <rect x={p.x - 26} y={p.y + 18} width={52} height={3} fill={C.line} />
                <rect
                  x={p.x - 26}
                  y={p.y + 18}
                  width={(52 * Math.min(100, kpi?.prb_util ?? 0)) / 100}
                  height={3}
                  fill={loadHex(kpi?.prb_util ?? 0)}
                />

                {/* backhaul tick */}
                <rect x={p.x - 26} y={p.y + 26} width={9} height={2} fill={linkHex} />

                {cell && cell.energy_mode !== 'ACTIVE' ? (
                  <text
                    x={p.x + 26}
                    y={p.y + 29}
                    textAnchor="end"
                    fontSize="8"
                    letterSpacing="1"
                    fontFamily="JetBrains Mono, monospace"
                    fill={LEVEL_HEX[energyLevel(cell.energy_mode)]}
                  >
                    {cell.energy_mode}
                  </text>
                ) : null}

                {sla ? (
                  <g>
                    <circle cx={p.x} cy={p.y - 40} r={3.5} fill={C.coral}>
                      <animate
                        attributeName="opacity"
                        values="1;0.2;1"
                        dur="1.4s"
                        repeatCount="indefinite"
                      />
                    </circle>
                  </g>
                ) : null}
              </g>
            )
          })}
        </g>
      </svg>

      <div className="pointer-events-none absolute bottom-2 left-3 flex items-center gap-3">
        <span className="label">
          {LAYERS.find((l) => l.id === layer)?.label}
          {LAYERS.find((l) => l.id === layer)?.unit
            ? ` · ${LAYERS.find((l) => l.id === layer)?.unit}`
            : ''}
        </span>
      </div>

      <div className="absolute bottom-2 right-3 flex items-center gap-1.5">
        <span className="num mr-1 text-[10px] text-ink3">{Math.round(view.k * 100)}%</span>
        <button
          type="button"
          className="btn px-2 py-1"
          onClick={() => setView((v) => ({ ...v, k: Math.max(0.55, v.k - 0.15) }))}
        >
          −
        </button>
        <button
          type="button"
          className="btn px-2 py-1"
          onClick={() => setView((v) => ({ ...v, k: Math.min(3, v.k + 0.15) }))}
        >
          +
        </button>
        <button type="button" className="btn px-2 py-1" onClick={reset}>
          Fit
        </button>
      </div>
    </div>
  )
}
