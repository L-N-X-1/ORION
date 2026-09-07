import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { EChartsOption } from 'echarts'
import { useTelemetry } from '../api/telemetry'
import { POLL_SLOW, twin } from '../api/twin'
import type { Slice } from '../api/types'
import { Chart, chartBase } from '../components/Chart'
import { Panel } from '../components/Panel'
import { Tag } from '../components/Led'
import { useToast } from '../components/Toaster'
import { C, SERIES, withAlpha } from '../lib/status'
import { int, num } from '../lib/format'

const SLICE_HINT: Record<string, string> = {
  'slice-premium': 'Latency-critical subscribers. Priority 1 is the intended baseline.',
  'slice-standard': 'Bulk mobile broadband. The elastic middle tier.',
  'slice-iot': 'Massive machine-type traffic. Must never outrank premium.',
}

function SliceCard({ slice, colour }: { slice: Slice; colour: string }) {
  const span = Math.max(1, slice.max_bw_pct - slice.min_bw_pct)
  return (
    <div className="panel panel-ticks p-3">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0" style={{ backgroundColor: colour }} />
        <span className="num text-[12px] tracking-[0.1em] text-ink">{slice.slice_id}</span>
        <span className="num ml-auto text-[11px] text-ink3">P{slice.priority}</span>
      </div>

      <div className="mt-3">
        <div className="label mb-1.5">Bandwidth envelope</div>
        <div className="relative h-[6px] w-full bg-line">
          <div
            className="absolute h-full"
            style={{
              left: `${slice.min_bw_pct}%`,
              width: `${span}%`,
              backgroundColor: withAlpha(colour, 0.55),
            }}
          />
          <div
            className="absolute h-full w-[2px]"
            style={{ left: `${Math.min(100, slice.current_load * 100)}%`, backgroundColor: C.ink }}
          />
        </div>
        <div className="num mt-1 flex justify-between text-[10px] text-ink3">
          <span>min {num(slice.min_bw_pct, 0)}%</span>
          <span title="The simulator does not attribute per-slice load yet — this stays at 0.">
            load {num(slice.current_load * 100, 1)}%
          </span>
          <span>max {num(slice.max_bw_pct, 0)}%</span>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div>
          <div className="label mb-1">SLA latency</div>
          <div className="num text-[13px] text-ink">{num(slice.sla_latency_ms, 0)} ms</div>
        </div>
        <div>
          <div className="label mb-1">Priority</div>
          <div className="num text-[13px] text-ink">{slice.priority}</div>
        </div>
      </div>

      <p className="mt-2.5 text-[11px] leading-snug text-ink3">{SLICE_HINT[slice.slice_id] ?? ''}</p>
    </div>
  )
}

export function SlicesPage() {
  const { frame } = useTelemetry()
  const toast = useToast()
  const qc = useQueryClient()

  const slices = useMemo(() => Object.values(frame?.slices ?? {}), [frame])
  const sliceIds = useMemo(() => slices.map((s) => s.slice_id), [slices])

  const [target, setTarget] = useState('')
  const [minBw, setMinBw] = useState('')
  const [maxBw, setMaxBw] = useState('')
  const [priority, setPriority] = useState('')

  useEffect(() => {
    if (!target && sliceIds.length) setTarget(sliceIds[0])
  }, [sliceIds, target])

  const current = slices.find((s) => s.slice_id === target)

  useEffect(() => {
    if (!current) return
    setMinBw(String(current.min_bw_pct))
    setMaxBw(String(current.max_bw_pct))
    setPriority(String(current.priority))
  }, [current?.slice_id])

  const ues = useQuery({ queryKey: ['ues'], queryFn: twin.ues, refetchInterval: POLL_SLOW })
  const changes = useQuery({
    queryKey: ['changes'],
    queryFn: twin.changes,
    refetchInterval: POLL_SLOW,
  })

  const apply = useMutation({
    mutationFn: () =>
      twin.applySlicePolicy({
        slice_id: target,
        min_bw_pct: minBw === '' ? undefined : Number(minBw),
        max_bw_pct: maxBw === '' ? undefined : Number(maxBw),
        priority: priority === '' ? undefined : Number(priority),
      }),
    onSuccess: (res) => {
      toast.ok(`${target} policy applied`, `change ${res.change_id}`)
      void qc.invalidateQueries({ queryKey: ['changes'] })
      void qc.invalidateQueries({ queryKey: ['faults'] })
    },
    onError: (err: Error) => toast.fail('Slice policy rejected', err.message),
  })

  const inverted = useMemo(() => {
    const premium = slices.find((s) => s.slice_id === 'slice-premium')
    const iot = slices.find((s) => s.slice_id === 'slice-iot')
    return Boolean(premium && iot && premium.priority > iot.priority)
  }, [slices])

  const envelopeOption = useMemo<EChartsOption>(() => {
    const base = chartBase()
    return {
      ...base,
      grid: { left: 96, right: 20, top: 26, bottom: 24 },
      tooltip: { ...base.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: {
        show: true,
        top: 0,
        right: 0,
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: C.ink3, fontSize: 9, fontFamily: 'JetBrains Mono' },
      },
      xAxis: {
        type: 'value',
        max: 100,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: C.line } },
        axisLabel: { color: C.ink3, fontSize: 9, fontFamily: 'JetBrains Mono' },
      },
      yAxis: {
        type: 'category',
        data: sliceIds,
        axisLine: { lineStyle: { color: C.line2 } },
        axisTick: { show: false },
        axisLabel: { color: C.ink2, fontSize: 10, fontFamily: 'JetBrains Mono' },
      },
      series: [
        {
          name: 'min %',
          type: 'bar',
          stack: 'env',
          data: slices.map((s) => s.min_bw_pct),
          barWidth: 14,
          itemStyle: { color: withAlpha(C.teal, 0.35) },
        },
        {
          name: 'headroom %',
          type: 'bar',
          stack: 'env',
          data: slices.map((s) => Math.max(0, s.max_bw_pct - s.min_bw_pct)),
          barWidth: 14,
          itemStyle: { color: withAlpha(C.amber, 0.3) },
        },
        {
          name: 'current load %',
          type: 'bar',
          data: slices.map((s) => Number((s.current_load * 100).toFixed(2))),
          barWidth: 5,
          itemStyle: { color: C.ink },
        },
      ],
    }
  }, [slices, sliceIds])

  const sliceChanges = useMemo(
    () => (changes.data?.changes ?? []).filter((c) => c.type === 'slice_policy'),
    [changes.data],
  )

  return (
    <div className="flex flex-col gap-3">
      {inverted ? (
        <div className="panel border-coral/50 bg-coral/5 px-3 py-2">
          <span className="num text-[11px] uppercase tracking-[0.12em] text-coral">
            Policy inversion detected — IoT now outranks premium
          </span>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {slices.map((s, i) => (
          <SliceCard key={s.slice_id} slice={s} colour={SERIES[i % SERIES.length]} />
        ))}
        {slices.length === 0 ? (
          <div className="panel px-3 py-6 md:col-span-3">
            <span className="label">Waiting for slice state…</span>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 xl:flex-row">
        <Panel
          label="Bandwidth Envelopes"
          meta="min / headroom · load not yet simulated"
          className="h-[240px] min-w-0 flex-1"
          bodyClassName="p-2"
        >
          <Chart option={envelopeOption} />
        </Panel>

        <Panel label="Apply Slice Policy" className="xl:w-[340px] xl:shrink-0">
          <div className="flex flex-col gap-2.5">
            <label className="flex flex-col gap-1">
              <span className="label">Slice</span>
              <select
                className="field"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                {sliceIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-3 gap-2">
              <label className="flex flex-col gap-1">
                <span className="num text-[10px] text-ink3">min %</span>
                <input
                  className="field"
                  type="number"
                  value={minBw}
                  onChange={(e) => setMinBw(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="num text-[10px] text-ink3">max %</span>
                <input
                  className="field"
                  type="number"
                  value={maxBw}
                  onChange={(e) => setMaxBw(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="num text-[10px] text-ink3">priority</span>
                <input
                  className="field"
                  type="number"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                />
              </label>
            </div>

            <button
              type="button"
              className="btn btn-primary"
              disabled={!target || apply.isPending}
              onClick={() => apply.mutate()}
            >
              {apply.isPending ? 'Applying…' : 'Apply policy'}
            </button>

            <p className="text-[11px] leading-snug text-ink3">
              Lower priority number wins contention. Applying a slice policy also clears an
              active synthetic congestion fault, which is how the agent pipeline signals a
              successful remediation.
            </p>
          </div>
        </Panel>
      </div>

      <div className="flex flex-col gap-3 xl:flex-row">
        <Panel
          label="UE Distribution by Slice"
          meta={`${int(ues.data?.total)} UEs`}
          className="min-w-0 flex-1"
        >
          <div className="flex flex-col gap-2">
            {Object.entries(ues.data?.by_slice ?? {}).map(([sid, count], i) => {
              const total = ues.data?.total ?? 1
              return (
                <div key={sid} className="flex items-center gap-3">
                  <span className="num w-[120px] shrink-0 text-[11px] text-ink2">{sid}</span>
                  <div className="h-[6px] flex-1 bg-line">
                    <div
                      className="h-full"
                      style={{
                        width: `${(count / total) * 100}%`,
                        backgroundColor: SERIES[i % SERIES.length],
                      }}
                    />
                  </div>
                  <span className="num w-[54px] shrink-0 text-right text-[11px] text-ink">
                    {int(count)}
                  </span>
                </div>
              )
            })}
            {!ues.data ? <span className="label">Loading UE distribution…</span> : null}
          </div>
        </Panel>

        <Panel
          label="Slice Policy Changes"
          meta={`${sliceChanges.length}`}
          className="xl:w-[420px] xl:shrink-0"
          bodyClassName="overflow-y-auto max-h-[260px]"
          flush
        >
          {sliceChanges.length === 0 ? (
            <div className="px-3 py-6">
              <span className="label">No slice policy changes yet</span>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {sliceChanges.map((c) => (
                <li key={c.change_id} className="flex items-center gap-2 px-3 py-2">
                  <Tag level="elevated">{c.change_id}</Tag>
                  <span className="num truncate text-[11px] text-ink2">
                    {String((c.params as { slice_id?: string } | undefined)?.slice_id ?? '')}
                  </span>
                  <span className="num ml-auto shrink-0 text-[10px] text-ink3">
                    sim {Math.round(c.sim_time_s)}s
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  )
}
