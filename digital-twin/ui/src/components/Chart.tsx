import { useEffect, useRef } from 'react'
import * as echarts from 'echarts'
import type { EChartsOption } from 'echarts'
import { C, withAlpha } from '../lib/status'

const AXIS_LABEL = {
  color: C.ink3,
  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
  fontSize: 10,
} as const

/**
 * Shared chart chassis: hairline axes, monospace ticks, no gradients,
 * no drop shadows. Every chart in the console inherits this.
 */
export function chartBase(): EChartsOption {
  return {
    backgroundColor: 'transparent',
    animationDuration: 320,
    grid: { left: 46, right: 14, top: 18, bottom: 26, containLabel: false },
    textStyle: { fontFamily: 'Inter, system-ui, sans-serif' },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#171614',
      borderColor: C.line2,
      borderWidth: 1,
      padding: [6, 10],
      textStyle: { color: C.ink, fontSize: 11, fontFamily: 'JetBrains Mono, monospace' },
      axisPointer: {
        type: 'line',
        lineStyle: { color: withAlpha(C.amber, 0.45), width: 1, type: 'dashed' },
      },
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      axisLine: { lineStyle: { color: C.line2 } },
      axisTick: { show: false },
      axisLabel: { ...AXIS_LABEL },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...AXIS_LABEL },
      splitLine: { lineStyle: { color: C.line, type: 'solid' } },
    },
  }
}

interface ChartProps {
  option: EChartsOption
  className?: string
  height?: number | string
  onSelect?: (name: string) => void
}

export function Chart({ option, className = '', height = '100%', onSelect }: ChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const selectRef = useRef(onSelect)
  selectRef.current = onSelect

  useEffect(() => {
    if (!hostRef.current) return
    const chart = echarts.init(hostRef.current, undefined, { renderer: 'canvas' })
    chartRef.current = chart
    chart.on('click', (params: { name?: string }) => {
      if (params.name) selectRef.current?.(params.name)
    })
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(hostRef.current)
    return () => {
      ro.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true, lazyUpdate: true })
  }, [option])

  return <div ref={hostRef} className={className} style={{ height, width: '100%' }} />
}
