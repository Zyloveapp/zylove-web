import { useEffect, useState } from 'react'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import MatchRow from '../components/matches/MatchRow'
import ChatPlaceholder from '../components/matches/ChatPlaceholder'
import NoMatches from '../components/matches/NoMatches'
import {
  isUnread,
  markMatchRead,
  subscribeLastRead,
  subscribeMatches,
  type MatchEntry,
} from '../services/matches'

interface MatchesState {
  key: string
  matches: MatchEntry[]
  error: boolean
}

export default function Matches() {
  // AuthGuard guarantees a signed-in user on this route.
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const mode = useModeStore((s) => s.mode)
  const key = `${uid}:${mode}`

  const [state, setState] = useState<MatchesState | null>(null)
  const [lastRead, setLastRead] = useState<Map<string, number>>(new Map())
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => {
    if (!uid) return
    return subscribeMatches(
      uid,
      mode,
      (matches) => setState({ key, matches, error: false }),
      () => setState({ key, matches: [], error: true }),
    )
  }, [uid, mode, key])

  useEffect(() => {
    if (!uid) return
    return subscribeLastRead(uid, setLastRead)
  }, [uid])

  if (state?.key !== key) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      </div>
    )
  }

  const { matches, error } = state
  const active = matches.find((m) => m.matchId === activeId) ?? null
  const unreadCount = matches.filter((m) => isUnread(m, uid, lastRead)).length

  function select(m: MatchEntry) {
    setActiveId(m.matchId)
    // Same per-user read marker the mobile chat writes; clears the unread dot.
    markMatchRead(uid, m.matchId).catch(() => {})
  }

  if (!error && matches.length === 0) {
    return (
      <div className="h-screen bg-gray-950 lg:flex">
        <aside className="hidden w-80 shrink-0 border-r border-white/10 lg:block">
          <h1 className="px-4 py-5 text-xl font-bold text-white">Matches</h1>
        </aside>
        <main className="h-full flex-1">
          <NoMatches />
        </main>
      </div>
    )
  }

  return (
    <div className="flex h-screen bg-gray-950 text-white">
      <aside
        className={`w-full shrink-0 flex-col border-white/10 lg:flex lg:w-80 lg:border-r ${active ? 'hidden' : 'flex'}`}
      >
        <header className="flex items-center gap-2 px-4 py-5">
          <h1 className="text-xl font-bold text-white">Matches</h1>
          {unreadCount > 0 && (
            <span className="rounded-full bg-[#1B4FD8] px-2 py-0.5 text-xs font-semibold text-white">{unreadCount}</span>
          )}
        </header>
        {error ? (
          <p className="px-4 text-sm text-white/50">Couldn't load your matches.</p>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {matches.map((m) => (
              <MatchRow
                key={m.matchId}
                match={m}
                unread={isUnread(m, uid, lastRead)}
                active={m.matchId === activeId}
                onSelect={() => select(m)}
              />
            ))}
          </div>
        )}
      </aside>

      <main className={`flex-1 ${active ? 'block' : 'hidden lg:block'}`}>
        {active ? (
          <ChatPlaceholder match={active} onBack={() => setActiveId(null)} />
        ) : (
          <div className="flex h-full items-center justify-center text-white/30">Select a match to start chatting</div>
        )}
      </main>
    </div>
  )
}
