import type { ReactNode } from 'react'
import type { Level } from '../lib/status'
import { LEVEL_HEX } from '../lib/status'

interface StatProps {
  label: string
  value: ReactNode
  unit?: string
  sub?: ReactNode
  level?: Level
  /** 0..1 — draws a thin fill rail under the value. */
  fill?: number
}

export function Stat({ label, value, unit, sub, level = 'idle', fill }: StatProps) {
  const hex = LEVEL_HEX[level]
  return (
    <div className="panel panel-ticks relative overflow-hidden px-3 py-2.5">
      <div
        className="absolute left-0 top-0 h-full w-[2px]"
        style={{ backgroundColor: level === 'idle' ? '#332F2A' : hex }}
      />
      <div className="label mb-1.5 truncate">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className="num text-[22px] leading-none" style={{ color: hex }}>
          {value}
        </span>
        {unit ? <span className="num text-[11px] text-ink3">{unit}</span> : null}
      </div>
      {fill !== undefined ? (
        <div className="mt-2 h-[3px] w-full bg-line">
          <div
            className="h-full transition-[width] duration-500"
            style={{ width: `${Math.max(0, Math.min(1, fill)) * 100}%`, backgroundColor: hex }}
          />
        </div>
      ) : null}
      {sub ? <div className="num mt-1.5 truncate text-[11px] text-ink3">{sub}</div> : null}
    </div>
  )
}

interface FieldProps {
  label: string
  value: ReactNode
  level?: Level
  unit?: string
}

/** Compact label/value pair used inside inspectors and detail grids. */
export function Field({ label, value, level, unit }: FieldProps) {
  return (
    <div className="border-l border-line pl-2">
      <div className="label mb-1 truncate">{label}</div>
      <div className="flex items-baseline gap-1">
        <span
          className="num text-[14px]"
          style={{ color: level ? LEVEL_HEX[level] : '#F0EAE0' }}
        >
          {value}
        </span>
        {unit ? <span className="num text-[10px] text-ink3">{unit}</span> : null}
      </div>
    </div>
  )
}
