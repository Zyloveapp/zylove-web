import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchBlockedUsers } from '../services/safety'
import { useModeStore } from '../store/modeStore'

// Settings → Safety row. Shows the count once loaded; a failed load just
// leaves the count off.
export default function BlockedUsersLink() {
  const mode = useModeStore((s) => s.mode)
  const [loaded, setLoaded] = useState<{ mode: string; count: number } | null>(null)
  const count = loaded?.mode === mode ? loaded.count : null

  useEffect(() => {
    let cancelled = false
    fetchBlockedUsers(mode)
      .then((list) => !cancelled && setLoaded({ mode, count: list.length }))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [mode])

  return (
    <Link
      to="/settings/blocked"
      className="flex w-full items-center justify-between border-t border-white/5 px-5 py-4 text-left hover:bg-white/[0.03]"
    >
      <span>
        <span className="block font-medium">Blocked users{count ? ` (${count})` : ''}</span>
        <span className="block text-sm text-white/50">See and manage who you've blocked.</span>
      </span>
      <span className="text-white/30" aria-hidden>
        ›
      </span>
    </Link>
  )
}
