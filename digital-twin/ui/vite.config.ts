import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: proxy to the twin on its host-published port.
// Docker: nginx does the same proxying, so the browser only ever talks to
// same-origin /api/* and /grafana/*.
const TWIN_TARGET = process.env.TWIN_TARGET || 'http://localhost:8001'
const GRAFANA_TARGET = process.env.GRAFANA_TARGET || 'http://localhost:3001'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // ECharts is most of the bundle and changes far less often than the
        // app code — keep it in its own long-lived chunk.
        manualChunks: {
          echarts: ['echarts'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api/twin': {
        target: TWIN_TARGET,
        changeOrigin: true,
        ws: true,
        rewrite: (p) => p.replace(/^\/api\/twin/, ''),
      },
      '/grafana': {
        target: GRAFANA_TARGET,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/grafana/, ''),
      },
    },
  },
})
