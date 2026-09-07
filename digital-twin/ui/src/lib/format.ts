export function num(value: number | undefined | null, digits = 1): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—'
  return value.toFixed(digits)
}

export function int(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—'
  return Math.round(value).toLocaleString('en-US')
}

export function pct(value: number | undefined | null, digits = 1): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—'
  return `${value.toFixed(digits)}%`
}

/** Simulated seconds -> HH:MM:SS of simulated uptime. */
export function simClock(seconds: number | undefined): string {
  if (seconds === undefined || Number.isNaN(seconds)) return '--:--:--'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':')
}

export function clockTime(iso: string | undefined): string {
  if (!iso) return '--:--:--'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  return d.toLocaleTimeString('en-GB', { hour12: false })
}

export function relativeTime(iso: string | undefined): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const delta = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (delta < 60) return `${delta}s ago`
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  return `${Math.floor(delta / 3600)}h ago`
}

export function signed(value: number, digits = 1): string {
  if (Number.isNaN(value)) return '—'
  const s = value.toFixed(digits)
  return value > 0 ? `+${s}` : s
}

export function titleise(raw: string): string {
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}
