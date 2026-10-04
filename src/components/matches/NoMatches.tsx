import { Link } from 'react-router-dom'
import { useModeStore } from '../../store/modeStore'

export default function NoMatches() {
  const play = useModeStore((s) => s.mode) === 'play'
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <span className={`mb-5 text-5xl ${play ? 'opacity-40' : 'text-white/30'}`} aria-hidden>
        {play ? '🔥' : '✦'}
      </span>
      <h2 className="text-xl font-semibold text-white/40">No connections yet</h2>
      <p className="mt-2 max-w-sm text-white/30">
        When someone you're interested in feels the same way, they'll appear here.
      </p>
      <Link to="/discover" className="mt-6 text-sm text-white/40 underline hover:text-white/60">
        Back to Explore
      </Link>
    </div>
  )
}
