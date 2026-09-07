export type EnergyMode = 'ACTIVE' | 'SLEEP' | 'SHUTDOWN'
export type LinkStatus = 'UP' | 'DEGRADED' | 'DOWN'

export interface CellKPI {
  cell_id: string
  ts: string
  sim_time_s: number
  tick: number
  is_peak: boolean
  prb_util: number
  throughput_mbps: number
  sinr_db: number
  cqi: number
  latency_p95_ms: number
  packet_loss_pct: number
  cpu_load_pct: number
  ho_fail_rate: number
  energy_mode: EnergyMode
  sla_violation: boolean
  current_load?: number
  _live?: boolean
}

export interface Cell {
  cell_id: string
  max_prb: number
  effective_prb: number
  energy_mode: EnergyMode
  neighbours: string[]
  current_load: number
  a3_offset: number
  ttt_ms: number
  ho_attempts: number
  ho_failures: number
}

export interface Backhaul {
  cell_id: string
  delay_ms: number
  loss_pct: number
  status: LinkStatus
}

export interface Slice {
  slice_id: string
  priority: number
  min_bw_pct: number
  max_bw_pct: number
  sla_latency_ms: number
  current_load: number
}

export interface NetworkEvent {
  event_id: string
  correlation_id: string
  event_type: string
  entity_id: string
  severity: string
  ts: string
  sim_time_s: number
  evidence: Record<string, unknown>
}

export interface TwinHealth {
  status: string
  service: string
  sim_time_s: number
  tick: number
  cells: number
  tick_interval_s: number
  kafka: string
  influxdb: string
  dataset_dir: string
  dataset_sources: unknown[]
}

export interface Topology {
  cells: Record<string, Cell>
  backhaul: Record<string, Backhaul>
  slices: Record<string, Slice>
  ue_count: number
}

export interface ChangeRecord {
  change_id: string
  type: string
  sim_time_s: number
  cell_id?: string
  slice_id?: string
  mode?: string
  params?: Record<string, unknown>
  previous?: Record<string, unknown>
}

export interface FaultSurface {
  active: boolean
  pinned_loads: Record<string, number>
  synthetic_faults: Record<string, { cells?: string[]; prb_override?: number }>
  degraded_backhaul: Backhaul[]
  non_active_cells: { cell_id: string; energy_mode: EnergyMode }[]
  handover_anomalies: { cell_id: string; a3_offset: number; ttt_ms: number }[]
  slice_priority_inverted: boolean
}

export interface UeDistribution {
  total: number
  per_cell: Record<string, { total: number; by_slice: Record<string, number> }>
  by_slice: Record<string, number>
}

export interface TelemetryFrame {
  type: 'snapshot' | 'tick' | 'heartbeat'
  tick: number
  sim_time_s: number
  tick_interval_s: number
  ts: string
  kpis: CellKPI[]
  cells: Record<string, Cell>
  slices: Record<string, Slice>
  backhaul: Record<string, Backhaul>
  events: NetworkEvent[]
  pinned_loads: Record<string, number>
  synthetic_faults: Record<string, { cells?: string[]; prb_override?: number }>
}

export interface WhatIfCellResult {
  cell_id: string
  baseline: {
    prb_util: number
    throughput_mbps: number
    latency_p95_ms: number
    packet_loss_pct: number
    sla_violations: number
  }
  with_action: {
    prb_util: number
    throughput_mbps: number
    latency_p95_ms: number
    packet_loss_pct: number
    sla_violations: number
  }
  delta: {
    prb_util: number
    throughput_mbps: number
    latency_p95_ms: number
    packet_loss_pct: number
  }
}

export interface WhatIfReport {
  action_plan: Record<string, unknown>
  horizon_ticks: number
  horizon_minutes: number
  cells_analysed: number
  overall: {
    sla_violations_baseline: number
    sla_violations_action: number
    sla_improvement: number
    confidence: number
  }
  per_cell: WhatIfCellResult[]
}
