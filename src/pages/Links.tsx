import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import MatchRow from '../components/matches/MatchRow'
import { loadChatPreview, type ChatPreview } from '../services/chatPreview'
import ChatView from '../components/chat/ChatView'
import NoMatches from '../components/matches/NoMatches'
import IgnitedRow from '../components/matches/IgnitedRow'
import LockedPlayConnections from '../components/matches/LockedPlayConnections'
import {
  hasMessages,
  isUnread,
  subscribeLastRead,
  subscribeMatches,
  type MatchEntry,
} from '../services/matches'

interface LinksState {
  key: string
  matches: MatchEntry[]
  error: boolean
}

// Links (Spark) / Chats (Play): new links up top, then conversations.
export default function Links() {
  // AuthGuard guarantees a signed-in user on this route.
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const mode = useModeStore((s) => s.mode)
  const key = `${uid}:${mode}`

  const [state, setState] = useState<LinksState | null>(null)
  const [lastRead, setLastRead] = useState<Map<string, number>>(new Map())
  const [activeId, setActiveId] = useState<string | null>(null)
  // Decrypted last-message previews, keyed `${matchId}:${lastMessageAt}` so a
  // new message shows the loader line until its preview arrives.
  const [previews, setPreviews] = useState<Map<string, ChatPreview | null>>(new Map())
  const navigate = useNavigate()
  // Bumped by "Try again" to resubscribe after a failed load.
  const [reload, setReload] = useState(0)
  const openProfile = (m: MatchEntry) => navigate(`/profile/${m.partnerUid}`)

  useEffect(() => {
    if (!uid) return
    return subscribeMatches(
      uid,
      mode,
      (matches) => setState({ key, matches, error: false }),
      () => setState({ key, matches: [], error: true }),
    )
  }, [uid, mode, key, reload])

  useEffect(() => {
    if (!uid) return
    return subscribeLastRead(uid, setLastRead)
  }, [uid])

  const listedMatches = state?.key === key ? state.matches : null
  useEffect(() => {
    if (!uid || !listedMatches) return
    let cancelled = false
    for (const m of listedMatches) {
      if (m.ended || m.lastMessageAt <= 0) continue
      const previewKey = `${m.matchId}:${m.lastMessageAt}`
      loadChatPreview(m, uid).then((preview) => {
        if (!cancelled) setPreviews((prev) => (prev.get(previewKey) === preview ? prev : new Map(prev).set(previewKey, preview)))
      })
    }
    return () => {
      cancelled = true
    }
  }, [uid, listedMatches])

  if (state?.key !== key) {
    return (
      <div className="flex min-h-[calc(100dvh-7rem)] lg:min-h-[calc(100dvh-7.5rem)] items-center justify-center bg-gray-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      </div>
    )
  }

  const { matches, error } = state
  const active = matches.find((m) => m.matchId === activeId) ?? null
  const unreadCount = matches.filter((m) => !m.ended && isUnread(m, uid, lastRead)).length
  // Not yet messaged → the Ignited/Lit row; everything else is a conversation.
  const ignited = matches
    .filter((m) => !hasMessages(m) && !m.ended)
    .sort((a, b) => b.matchedAt - a.matchedAt)
  // Blocked and unmatched connections leave the list.
  const conversations = matches.filter((m) => hasMessages(m) && !m.ended)
  const isPlay = mode === 'play'
  const title = isPlay ? '🔥 Chats 🔥' : '✦ Links ✦'
  const accent = isPlay ? 'text-[#E03131]' : 'text-[#1B4FD8]'

  // ChatView marks the conversation read when it opens.
  function select(m: MatchEntry) {
    setActiveId(m.matchId)
  }

  if (!error && ignited.length === 0 && conversations.length === 0) {
    return (
      <div className="h-[calc(100dvh-7rem)] lg:h-[calc(100dvh-7.5rem)] bg-gray-950 lg:flex">
        <aside className="hidden w-80 shrink-0 border-r border-white/10 lg:block">
          <h1 className="px-4 py-5 text-2xl font-extrabold text-white">{title}</h1>
        </aside>
        <main className="h-full flex-1">
          {mode === 'spark' && <LockedPlayConnections />}
          <NoMatches />
        </main>
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100dvh-7rem)] lg:h-[calc(100dvh-7.5rem)] bg-gray-950 text-white">
      <aside
        className={`w-full shrink-0 flex-col border-white/10 lg:flex lg:w-80 lg:border-r ${active ? 'hidden' : 'flex'}`}
      >
        <header className="flex items-center justify-between px-4 py-5">
          <h1 className="text-2xl font-extrabold text-white">
            {title}
            {unreadCount > 0 && <span className="sr-only">, {unreadCount} unread</span>}
          </h1>
          <span className={`text-3xl font-bold ${accent}`}>{ignited.length + conversations.length}</span>
        </header>
        {error ? (
          <div className="flex flex-col items-start gap-3 px-4">
            <p className="text-sm text-white/50">Couldn't load your matches.</p>
            <button
              type="button"
              onClick={() => {
                setState(null)
                setReload((n) => n + 1)
              }}
              className="text-sm text-white/40 underline hover:text-white/60"
            >
              Try again
            </button>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {mode === 'spark' && <LockedPlayConnections />}
            {ignited.length > 0 && (
              <IgnitedRow
                title={isPlay ? '🔥 Entanglements' : null}
                matches={ignited}
                mode={mode}
                activeId={activeId}
                onSelect={openProfile}
              />
            )}
            {conversations.length > 0 ? (
              <section>
                <h2 className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-widest text-white/40">
                  {isPlay ? 'Chats' : 'Connections'} · {conversations.length}
                </h2>
                {conversations.map((m) => (
                  <MatchRow
                    key={m.matchId}
                    match={m}
                    unread={isUnread(m, uid, lastRead)}
                    preview={previews.get(`${m.matchId}:${m.lastMessageAt}`)}
                    active={m.matchId === activeId}
                    onSelect={() => select(m)}
                    onOpenProfile={() => openProfile(m)}
                  />
                ))}
              </section>
            ) : (
              <p className="px-4 pt-4 text-center text-sm text-white/50">Start a conversation {isPlay ? '🔥' : '✦'}</p>
            )}
          </div>
        )}
      </aside>

      <main className={`flex-1 ${active ? 'block' : 'hidden lg:block'}`}>
        {active ? (
          <ChatView key={active.matchId} uid={uid} match={active} onBack={() => setActiveId(null)} />
        ) : (
          <div className="flex h-full items-center justify-center text-white/30">Select a match to start chatting</div>
        )}
      </main>
    </div>
  )
}
