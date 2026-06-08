import { useQuery } from '@tanstack/react-query'
import { twinApi } from '../api/digitalTwin'
import { actuatorApi } from '../api/actuator'
import { agentApi } from '../api/aiAgent'
import { POLL_SLOW } from '../config'

interface HeaderProps {
  active: string
  onNav: (page: string) => void
}

const NAV = ['Dashboard', 'Digital Twin', 'AI Agent', 'Actuator']

function Dot({ ok }: { ok: boolean | undefined }) {
  if (ok === undefined) return <span className="w-2 h-2 rounded-full bg-gray-400 inline-block" />
  return <span className={`w-2 h-2 rounded-full inline-block ${ok ? 'bg-emerald-400' : 'bg-red-500'}`} />
}

export default function Header({ active, onNav }: HeaderProps) {
  const twin = useQuery({ queryKey: ['twin', 'health'], queryFn: twinApi.health, refetchInterval: POLL_SLOW, retry: 1 })
  const act  = useQuery({ queryKey: ['act',  'health'], queryFn: actuatorApi.health, refetchInterval: POLL_SLOW, retry: 1 })
  const agent = useQuery({ queryKey: ['agent', 'health'], queryFn: agentApi.health, refetchInterval: POLL_SLOW, retry: 1 })

  return (
    <header className="bg-gray-900 text-white shadow-lg">
      <div className="max-w-screen-xl mx-auto px-6">
        {/* Brand row */}
        <div className="flex items-center justify-between py-3 border-b border-gray-700">
          <div className="flex items-center gap-3">
            {/* ORION constellation logo */}
            <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
              <circle cx="18" cy="18" r="17" stroke="#3b82f6" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.5" />
              <circle cx="18" cy="18" r="2.5" fill="#3b82f6" />
              <circle cx="9" cy="9"   r="2"   fill="#60a5fa" />
              <circle cx="27" cy="9"  r="2"   fill="#60a5fa" />
              <circle cx="9" cy="27"  r="2"   fill="#60a5fa" />
              <circle cx="27" cy="27" r="2"   fill="#60a5fa" />
              <circle cx="18" cy="4"  r="1.5" fill="#93c5fd" />
              <circle cx="32" cy="18" r="1.5" fill="#93c5fd" />
              <circle cx="4" cy="18"  r="1.5" fill="#93c5fd" />
              <line x1="9"  y1="9"  x2="18" y2="18" stroke="#3b82f6" strokeWidth="0.8" opacity="0.6" />
              <line x1="27" y1="9"  x2="18" y2="18" stroke="#3b82f6" strokeWidth="0.8" opacity="0.6" />
              <line x1="9"  y1="27" x2="18" y2="18" stroke="#3b82f6" strokeWidth="0.8" opacity="0.6" />
              <line x1="27" y1="27" x2="18" y2="18" stroke="#3b82f6" strokeWidth="0.8" opacity="0.6" />
            </svg>
            <div>
              <div className="text-xl font-bold tracking-widest text-blue-400">ORION</div>
              <div className="text-xs text-gray-400 -mt-0.5">Network Intelligence Platform</div>
            </div>
          </div>

          {/* Service status pills */}
          <div className="flex items-center gap-4 text-xs text-gray-300">
            <span className="flex items-center gap-1.5">
              <Dot ok={twin.data ? true : twin.isError ? false : undefined} />
              Digital Twin
            </span>
            <span className="flex items-center gap-1.5">
              <Dot ok={act.data ? true : act.isError ? false : undefined} />
              Actuator
            </span>
            <span className="flex items-center gap-1.5">
              <Dot ok={agent.data ? true : agent.isError ? false : undefined} />
              AI Agent
            </span>
            <a
              href="/grafana/"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-blue-400 hover:text-blue-300 underline underline-offset-2"
            >
              Grafana ↗
            </a>
          </div>
        </div>

        {/* Nav row */}
        <nav className="flex gap-1 py-1">
          {NAV.map((page) => (
            <button
              key={page}
              onClick={() => onNav(page)}
              className={`px-4 py-2 text-sm rounded transition-colors ${
                active === page
                  ? 'bg-blue-600 text-white font-semibold'
                  : 'text-gray-400 hover:text-white hover:bg-gray-700'
              }`}
            >
              {page}
            </button>
          ))}
        </nav>
      </div>
    </header>
  )
}
