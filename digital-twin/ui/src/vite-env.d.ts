/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GRAFANA_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
