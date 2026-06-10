import { useState, useEffect } from 'react'
import Header from './components/Header'
import Dashboard from './pages/Dashboard'
import DigitalTwin from './pages/DigitalTwin'
import AIAgent from './pages/AIAgent'
import Actuator from './pages/Actuator'

const PAGES: Record<string, React.ComponentType> = {
  'Dashboard':    Dashboard,
  'Digital Twin': DigitalTwin,
  'AI Agent':     AIAgent,
  'Actuator':     Actuator,
}

export default function App() {
  const [activePage, setActivePage] = useState('Dashboard')
  const [isDark, setIsDark] = useState(false)
  const Page = PAGES[activePage] ?? Dashboard

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
  }, [isDark])

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors">
      <Header
        active={activePage}
        onNav={setActivePage}
        isDark={isDark}
        onToggleDark={() => setIsDark(d => !d)}
      />
      <main className="max-w-screen-xl mx-auto px-6 py-6">
        <Page />
      </main>
    </div>
  )
}
