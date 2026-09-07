import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { LEVEL_HEX } from '../lib/status'
import type { Level } from '../lib/status'

interface Toast {
  id: number
  level: Level
  title: string
  detail?: string
}

interface ToastApi {
  ok: (title: string, detail?: string) => void
  warn: (title: string, detail?: string) => void
  fail: (title: string, detail?: string) => void
}

const noop: ToastApi = { ok: () => {}, warn: () => {}, fail: () => {} }
const ToastContext = createContext<ToastApi>(noop)

export function Toaster({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)

  const push = useCallback((level: Level, title: string, detail?: string) => {
    seq.current += 1
    const id = seq.current
    setToasts((prev) => [...prev.slice(-3), { id, level, title, detail }])
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 6000)
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      ok: (title, detail) => push('nominal', title, detail),
      warn: (title, detail) => push('elevated', title, detail),
      fail: (title, detail) => push('critical', title, detail),
    }),
    [push],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[320px] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="panel pointer-events-auto flex gap-2.5 border-l-2 bg-panel2 px-3 py-2"
            style={{ borderLeftColor: LEVEL_HEX[t.level] }}
          >
            <div className="min-w-0">
              <div className="num text-[11px]" style={{ color: LEVEL_HEX[t.level] }}>
                {t.title}
              </div>
              {t.detail ? (
                <div className="mt-0.5 break-words text-[11px] text-ink3">{t.detail}</div>
              ) : null}
            </div>
            <button
              type="button"
              className="ml-auto shrink-0 text-ink3 hover:text-ink"
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  return useContext(ToastContext)
}
