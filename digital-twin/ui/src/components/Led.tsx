import type { Level } from '../lib/status'
import { LEVEL_HEX } from '../lib/status'

interface LedProps {
  level: Level
  pulse?: boolean
  size?: number
  title?: string
}

/** A square indicator, not a rounded pill — the console reads as hardware. */
export function Led({ level, pulse = false, size = 7, title }: LedProps) {
  const hex = LEVEL_HEX[level]
  return (
    <span
      title={title}
      className={`inline-block shrink-0 ${pulse ? 'animate-pulseled' : ''}`}
      style={{
        width: size,
        height: size,
        backgroundColor: hex,
        boxShadow: level === 'idle' ? 'none' : `0 0 6px ${hex}66`,
      }}
    />
  )
}

interface TagProps {
  level?: Level
  children: React.ReactNode
  title?: string
}

export function Tag({ level = 'idle', children, title }: TagProps) {
  const hex = LEVEL_HEX[level]
  return (
    <span
      title={title}
      className="num inline-flex items-center gap-1.5 border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em]"
      style={{ borderColor: `${hex}55`, color: hex, backgroundColor: `${hex}12` }}
    >
      {children}
    </span>
  )
}
