import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api/twin':  { target: 'http://localhost:8001', changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/twin/, '') },
      '/api/act':   { target: 'http://localhost:8003', changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/act/, '')  },
      '/api/agent': { target: 'http://localhost:8004', changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/agent/, '') },
    },
  },
})
