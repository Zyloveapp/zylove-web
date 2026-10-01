import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import MatchRow from '../components/matches/MatchRow'
import ChatView from '../components/chat/ChatView'
import NoMatches from '../components/matches/NoMatches'
import SparksList from '../components/matches/SparksList'
import SparkProfileView from '../components/matches/SparkProfileView'
import MatchOverlay from '../components/discover/MatchOverlay'
import {
  isUnread,
  subscribeLastRead,
  subscribeMatches,
  type MatchEntry,
} from '../services/matches'
import { subscribeSparks, type SparkEntry } from '../services/sparks'

interface MatchesState {
  key: string
  matches: MatchEntry[]
  error: boolean
}

interface SparksState {
  key: string
  sparks: SparkEntry[]
  error: boolean
}

type Tab = 'matches' | 'sparks'

function Spinner() {
  return <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
}

export default function Matches() {
  // AuthGuard guarantees a signed-in user on this route.
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const mode = useModeStore((s) => s.mode)
  const key = `${uid}:${mode}`

  const [state, setState] = useState<MatchesState | null>(null)
  const [sparksState, setSparksState] = useState<SparksState | null>(null)
  const [lastRead, setLastRead] = useState<Map<string, number>>(new Map())
  const [activeId, setActiveId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('matches')
  const [selectedSpark, setSelectedSpark] = useState<SparkEntry | null>(null)
  const [newMatch, setNewMatch] = useState<{ matchId: string; name: string } | null>(null)

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
    return subscribeSparks(
      uid,
      mode,
      (sparks) => setSparksState({ key, sparks, error: false }),
      () => setSparksState({ key, sparks: [], error: true }),
    )
  }, [uid, mode, key])

  useEffect(() => {
    if (!uid) return
    return subscribeLastRead(uid, setLastRead)
  }, [uid])

  const matches = useMemo(() => (state?.key === key ? state.matches : []), [state, key])
  const matchedUids = useMemo(() => new Set(matches.map((m) => m.partnerUid)), [matches])

  // After the overlay: open the new conversation (it shows once the matches
  // listener delivers the new doc).
  const openNewMatch = useCallback(() => {
    if (!newMatch) return
    setSelectedSpark(null)
    setTab('matches')
    setActiveId(newMatch.matchId)
    setNewMatch(null)
  }, [newMatch])

  if (state?.key !== key) {
    return (
      <div className="flex min-h-[calc(100dvh-4rem)] lg:min-h-[calc(100dvh-3.5rem)] items-center justify-center bg-gray-950">
        <Spinner />
      </div>
    )
  }

  const { error } = state
  const sparks = sparksState?.key === key ? sparksState : null
  const active = tab === 'matches' ? (matches.find((m) => m.matchId === activeId) ?? null) : null
  const unreadCount = matches.filter((m) => isUnread(m, uid, lastRead)).length
  const noMatches = !error && matches.length === 0

  const tabClass = (t: Tab) =>
    `-mb-px border-b-2 pb-2 text-sm font-medium transition-colors ${
      tab === t ? 'border-[#1B4FD8] text-white' : 'border-transparent text-white/40 hover:text-white/60'
    }`

  let list
  if (tab === 'sparks') {
    list = !sparks ? (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    ) : sparks.error ? (
      <p className="px-4 text-sm text-white/50">Couldn't load your sparks.</p>
    ) : (
      <SparksList sparks={sparks.sparks} matchedUids={matchedUids} onSelect={setSelectedSpark} />
    )
  } else if (error) {
    list = <p className="px-4 text-sm text-white/50">Couldn't load your matches.</p>
  } else if (noMatches) {
    list = (
      <div className="h-full lg:hidden">
        <NoMatches />
      </div>
    )
  } else {
    list = matches.map((m) => (
      <MatchRow
        key={m.matchId}
        match={m}
        unread={isUnread(m, uid, lastRead)}
        active={m.matchId === activeId}
        // ChatView marks the conversation read when it opens.
        onSelect={() => setActiveId(m.matchId)}
      />
    ))
  }

  return (
    <div className="flex h-[calc(100dvh-4rem)] lg:h-[calc(100dvh-3.5rem)] bg-gray-950 text-white">
      <aside
        className={`w-full shrink-0 flex-col border-white/10 lg:flex lg:w-80 lg:border-r ${active ? 'hidden' : 'flex'}`}
      >
        <header className="px-4 pt-5">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-white">Matches</h1>
            {unreadCount > 0 && (
              <span className="rounded-full bg-[#1B4FD8] px-2 py-0.5 text-xs font-semibold text-white">{unreadCount}</span>
            )}
          </div>
          <nav className="mt-4 flex gap-6 border-b border-white/10" aria-label="Matches sections">
            <button type="button" onClick={() => setTab('matches')} className={tabClass('matches')}>
              Matches
            </button>
            <button type="button" onClick={() => setTab('sparks')} className={tabClass('sparks')}>
              Sparks ✦
            </button>
          </nav>
        </header>
        <div className="flex-1 overflow-y-auto pt-2">{list}</div>
      </aside>

      <main className={`flex-1 ${active ? 'block' : 'hidden lg:block'}`}>
        {active ? (
          <ChatView key={active.matchId} uid={uid} match={active} onBack={() => setActiveId(null)} />
        ) : tab === 'matches' && noMatches ? (
          <NoMatches />
        ) : (
          <div className="flex h-full items-center justify-center text-white/30">
            {tab === 'sparks' ? 'Select a spark to see their profile' : 'Select a match to start chatting'}
          </div>
        )}
      </main>

      {selectedSpark && (
        <SparkProfileView
          key={selectedSpark.likerUid}
          uid={uid}
          spark={selectedSpark}
          matched={matchedUids.has(selectedSpark.likerUid)}
          onClose={() => setSelectedSpark(null)}
          onMatched={(matchId, name) => setNewMatch({ matchId, name })}
        />
      )}

      {newMatch && <MatchOverlay name={newMatch.name} onDone={openNewMatch} />}
    </div>
  )
}
