export type Level = 'nominal' | 'elevated' | 'critical' | 'idle'

/** Palette mirror of tailwind.config.js — needed where ECharts/SVG take raw hex. */
export const C = {
  void: '#0B0A09',
  panel: '#121110',
  panel2: '#171614',
  raise: '#1E1C19',
  line: '#262320',
  line2: '#332F2A',
  ink: '#F0EAE0',
  ink2: '#9E978B',
  ink3: '#6A645B',
  amber: '#FFB01F',
  amber2: '#C98A1A',
  teal: '#3FBFA8',
  coral: '#FF5F52',
  sand: '#D9C48F',
  steel: '#7E93A8',
  lime: '#A8C246',
  clay: '#C97B5A',
} as const

/** Series colours for multi-line charts — ordered for maximum separation. */
export const SERIES = [C.teal, C.amber, C.coral, C.steel, C.lime, C.sand, C.clay] as const

export const LEVEL_HEX: Record<Level, string> = {
  nominal: C.teal,
  elevated: C.amber,
  critical: C.coral,
  idle: C.ink3,
}

export const LEVEL_TEXT: Record<Level, string> = {
  nominal: 'text-teal',
  elevated: 'text-amber',
  critical: 'text-coral',
  idle: 'text-ink3',
}

export const LEVEL_BORDER: Record<Level, string> = {
  nominal: 'border-teal/40',
  elevated: 'border-amber/50',
  critical: 'border-coral/50',
  idle: 'border-line2',
}

function band(value: number, warn: number, crit: number): Level {
  if (value >= crit) return 'critical'
  if (value >= warn) return 'elevated'
  return 'nominal'
}

function bandInverted(value: number, warn: number, crit: number): Level {
  if (value <= crit) return 'critical'
  if (value <= warn) return 'elevated'
  return 'nominal'
}

/**
 * Thresholds are aligned with digital-twin/event_generator.py so the UI never
 * shows "nominal" for a KPI the twin is already raising an event on.
 */
export const KPI_LEVEL = {
  prb_util: (v: number) => band(v, 85, 95),
  cpu_load_pct: (v: number) => band(v, 75, 90),
  latency_p95_ms: (v: number) => band(v, 50, 100),
  packet_loss_pct: (v: number) => band(v, 1, 3),
  ho_fail_rate: (v: number) => band(v, 0.1, 0.25),
  sinr_db: (v: number) => bandInverted(v, 5, 0),
  cqi: (v: number) => bandInverted(v, 7, 4),
} as const

export function severityLevel(severity: string | undefined): Level {
  switch ((severity ?? '').toUpperCase()) {
    case 'CRITICAL':
    case 'HIGH':
      return 'critical'
    case 'MEDIUM':
      return 'elevated'
    case 'LOW':
      return 'nominal'
    default:
      return 'idle'
  }
}

export function energyLevel(mode: string): Level {
  if (mode === 'ACTIVE') return 'nominal'
  if (mode === 'SLEEP') return 'elevated'
  return 'critical'
}

export function linkLevel(status: string): Level {
  if (status === 'UP') return 'nominal'
  if (status === 'DEGRADED') return 'elevated'
  return 'critical'
}

/** Load ramp used by the topology canvas: teal -> amber -> coral. */
export function loadHex(prbUtil: number): string {
  const v = Math.max(0, Math.min(100, prbUtil))
  if (v < 60) return C.teal
  if (v < 85) return mix(C.teal, C.amber, (v - 60) / 25)
  return mix(C.amber, C.coral, Math.min(1, (v - 85) / 15))
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  const k = Math.max(0, Math.min(1, t))
  const to = (x: number, y: number) =>
    Math.round(x + (y - x) * k)
      .toString(16)
      .padStart(2, '0')
  return `#${to(r1, r2)}${to(g1, g2)}${to(b1, b2)}`
}

export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
