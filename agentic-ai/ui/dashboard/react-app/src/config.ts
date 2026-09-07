// In dev: vite proxies /api/twin → localhost:8001, /api/act → localhost:8003, /api/agent → localhost:8004
// In docker: nginx proxies same paths to the respective services
export const TWIN_BASE  = '/api/twin';
export const ACT_BASE   = '/api/act';
export const AGENT_BASE = '/api/agent';

export const POLL_FAST = 5_000;   // ms — KPI refresh
export const POLL_SLOW = 30_000;  // ms — health checks
