import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { TelemetryProvider } from './api/telemetry'
import { Shell } from './components/Shell'
import { Toaster } from './components/Toaster'
import { Overview } from './pages/Overview'
import { TopologyPage } from './pages/Topology'
import { CellsPage } from './pages/Cells'
import { CellDetail } from './pages/CellDetail'
import { SlicesPage } from './pages/Slices'
import { MobilityPage } from './pages/Mobility'
import { FaultsPage } from './pages/Faults'
import { WhatIfPage } from './pages/WhatIf'
import { AnalyticsPage } from './pages/Analytics'

export function App() {
  return (
    <BrowserRouter>
      <TelemetryProvider>
        <Toaster>
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<Overview />} />
              <Route path="topology" element={<TopologyPage />} />
              <Route path="cells" element={<CellsPage />} />
              <Route path="cells/:cellId" element={<CellDetail />} />
              <Route path="slices" element={<SlicesPage />} />
              <Route path="mobility" element={<MobilityPage />} />
              <Route path="faults" element={<FaultsPage />} />
              <Route path="what-if" element={<WhatIfPage />} />
              <Route path="analytics" element={<AnalyticsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </Toaster>
      </TelemetryProvider>
    </BrowserRouter>
  )
}
