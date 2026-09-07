import type { ReactNode } from 'react'

interface PanelProps {
  label: string
  meta?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  /** Drop the padded body wrapper — for canvases and tables that bleed to the edge. */
  flush?: boolean
}

export function Panel({
  label,
  meta,
  actions,
  children,
  className = '',
  bodyClassName = '',
  flush = false,
}: PanelProps) {
  return (
    <section className={`panel panel-ticks flex min-h-0 flex-col ${className}`}>
      <header className="flex h-9 shrink-0 items-center gap-3 border-b border-line px-3">
        <h2 className="label truncate">{label}</h2>
        {meta ? <div className="num min-w-0 truncate text-[11px] text-ink3">{meta}</div> : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
      </header>
      <div className={`min-h-0 flex-1 ${flush ? '' : 'p-3'} ${bodyClassName}`}>{children}</div>
    </section>
  )
}
