import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Cell } from '../api/types'
import { twin } from '../api/twin'
import { useToast } from './Toaster'

const MODES: { id: string; hint: string }[] = [
  { id: 'ACTIVE', hint: 'Full PRB capacity' },
  { id: 'SLEEP', hint: '30% PRB — energy saving' },
  { id: 'SHUTDOWN', hint: 'Cell off — no PRB' },
]

interface CellActionsProps {
  cell: Cell | undefined
  compact?: boolean
}

/** Write path onto the twin: energy mode + handover parameters, with rollback ids. */
export function CellActions({ cell, compact = false }: CellActionsProps) {
  const toast = useToast()
  const qc = useQueryClient()
  const [a3, setA3] = useState('')
  const [ttt, setTtt] = useState('')

  useEffect(() => {
    setA3(cell ? String(cell.a3_offset) : '')
    setTtt(cell ? String(cell.ttt_ms) : '')
  }, [cell?.cell_id, cell?.a3_offset, cell?.ttt_ms])

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['changes'] })
    void qc.invalidateQueries({ queryKey: ['faults'] })
    void qc.invalidateQueries({ queryKey: ['topology'] })
  }

  const energy = useMutation({
    mutationFn: (mode: string) => twin.setEnergyMode({ cell_id: cell?.cell_id ?? '', mode }),
    onSuccess: (res, mode) => {
      toast.ok(`${cell?.cell_id} → ${mode}`, `change ${res.change_id} — revert from Faults`)
      invalidate()
    },
    onError: (err: Error) => toast.fail('Energy mode rejected', err.message),
  })

  const handover = useMutation({
    mutationFn: () =>
      twin.tuneHandover({
        cell_id: cell?.cell_id ?? '',
        a3_offset: a3 === '' ? undefined : Number(a3),
        ttt_ms: ttt === '' ? undefined : Number(ttt),
      }),
    onSuccess: (res) => {
      toast.ok(`${cell?.cell_id} handover tuned`, `change ${res.change_id}`)
      invalidate()
    },
    onError: (err: Error) => toast.fail('Handover tuning rejected', err.message),
  })

  if (!cell) {
    return <div className="label">Select a cell to act on it</div>
  }

  const busy = energy.isPending || handover.isPending

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="label mb-1.5">Energy Mode</div>
        <div className="flex gap-1.5">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              title={m.hint}
              disabled={busy || cell.energy_mode === m.id}
              className={`btn flex-1 ${cell.energy_mode === m.id ? 'btn-primary' : ''} ${
                m.id === 'SHUTDOWN' && cell.energy_mode !== 'SHUTDOWN' ? 'btn-danger' : ''
              }`}
              onClick={() => energy.mutate(m.id)}
            >
              {m.id}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="label mb-1.5">Handover Parameters</div>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="num text-[10px] text-ink3">A3 offset (dB)</span>
            <input
              className="field"
              type="number"
              step="0.1"
              value={a3}
              onChange={(e) => setA3(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="num text-[10px] text-ink3">TTT (ms)</span>
            <input
              className="field"
              type="number"
              step="10"
              value={ttt}
              onChange={(e) => setTtt(e.target.value)}
            />
          </label>
        </div>
        <button
          type="button"
          className="btn btn-primary mt-2 w-full"
          disabled={busy}
          onClick={() => handover.mutate()}
        >
          Apply handover change
        </button>
        {compact ? null : (
          <p className="mt-1.5 text-[11px] leading-snug text-ink3">
            A3 offset below 1.0 dB drops the handover trigger threshold and produces a mobility
            storm. Every change gets an id you can roll back from the Faults page.
          </p>
        )}
      </div>
    </div>
  )
}
