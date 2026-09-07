import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In Docker: env vars point to Docker service names.
// In local dev: fall back to localhost ports.
const TWIN_TARGET  = process.env.TWIN_TARGET  || 'http://localhost:8001'
const ACT_TARGET   = process.env.ACT_TARGET   || 'http://localhost:8003'
const AGENT_TARGET = process.env.AGENT_TARGET || 'http://localhost:8004'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api/twin':  { target: TWIN_TARGET,  changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/twin/, '')  },
      '/api/act':   { target: ACT_TARGET,   changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/act/, '')   },
      '/api/agent': { target: AGENT_TARGET, changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/agent/, '') },
    },
  },
})
