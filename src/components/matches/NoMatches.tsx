import { Link } from 'react-router-dom'

export default function NoMatches() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <span className="mb-5 text-5xl text-[#1B4FD8]">✦</span>
      <h2 className="text-xl font-semibold text-white">No matches yet</h2>
      <p className="mt-2 max-w-sm text-white/50">
        When someone you're interested in feels the same way, they'll appear here.
      </p>
      <Link to="/discover" className="mt-6 text-sm text-white/40 underline hover:text-white/60">
        Back to Discover
      </Link>
    </div>
  )
}
