import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import SparksList, { CuriousList, SentList } from '../components/matches/SparksList'
import SparkProfileView from '../components/matches/SparkProfileView'
import MatchOverlay, { type NewMatch } from '../components/discover/MatchOverlay'
import { CURIOUS_MAX, fetchCurious, fetchSentSparks, fetchSparkQueue, type CuriousResult, type SentSpark, type SparkEntry } from '../services/sparks'
import { PaywallCard, useCanAccess } from '../components/PaywallGate'

type Tab = 'sparks' | 'curious' | 'picks' | 'sent'

interface QueueState {
  key: string
  count: number
  live: SparkEntry[]
  viewed: SparkEntry[]
  error: boolean
}

// Sparks (Spark) / Flames (Play): people who liked you, who's curious about
// you, your best-matched Sparks (Top Picks), and likes you've sent.

// Top Picks only appears once there's enough to filter.
const TOP_PICKS_MIN_SPARKS = 4
const TOP_PICKS_COUNT = 3
export default function Sparks() {
  // AuthGuard guarantees a signed-in user on this route.
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const mode = useModeStore((s) => s.mode)
  const key = `${uid}:${mode}`
  const isPlay = mode === 'play'

  const [tab, setTab] = useState<Tab>('sparks')
  const [queue, setQueue] = useState<QueueState | null>(null)
  const [curious, setCurious] = useState<{ key: string; result: CuriousResult | null; error: boolean } | null>(null)
  const navigate = useNavigate()
  const [sent, setSent] = useState<{ key: string; list: SentSpark[] | null; error: boolean } | null>(null)
  const [selected, setSelected] = useState<SparkEntry | null>(null)
  const [newMatch, setNewMatch] = useState<NewMatch | null>(null)
  const sparksAllowed = useCanAccess('sparks')
  // Bumped by "Try again" (and after a like back or a pass) to reload.
  const [reload, setReload] = useState(0)
  function retry() {
    // Back to the spinner while it reloads.
    setQueue((q) => (q?.error ? null : q))
    setCurious((c) => (c?.error ? null : c))
    setSent((x) => (x?.error ? null : x))
    setReload((n) => n + 1)
  }

  // §4.A3: the queue comes from getLikes, by opaque like id — every plan
  // gets the count; Spark+ and Elite the likes, Free curated profiles' only.
  useEffect(() => {
    if (!uid || sparksAllowed === null) return
    let cancelled = false
    fetchSparkQueue(mode).then(
      ({ count, live, viewed }) => !cancelled && setQueue({ key, count, live, viewed, error: false }),
      () => !cancelled && setQueue({ key, count: 0, live: [], viewed: [], error: true }),
    )
    return () => {
      cancelled = true
    }
  }, [uid, mode, key, reload, sparksAllowed])

  // Curious comes from a callable; refreshed each time the tab opens.
  useEffect(() => {
    if (tab !== 'curious' || !uid) return
    let cancelled = false
    fetchCurious(mode)
      .then((result) => !cancelled && setCurious({ key, result, error: false }))
      .catch(() => !cancelled && setCurious({ key, result: null, error: true }))
    return () => {
      cancelled = true
    }
  }, [tab, uid, mode, key, reload])

  // Sent comes from a callable; fetched each time the tab is opened so new
  // likes from Explore show up.
  useEffect(() => {
    if (tab !== 'sent' || !uid) return
    let cancelled = false
    fetchSentSparks(mode)
      .then((list) => !cancelled && setSent({ key, list, error: false }))
      .catch(() => !cancelled && setSent({ key, list: [], error: true }))
    return () => {
      cancelled = true
    }
  }, [tab, uid, mode, key, reload])

  const loaded = queue?.key === key ? queue : null
  const liveCount = loaded?.live.length ?? 0

  // Best-matched incoming Sparks by the score saved with the like. Unscored
  // likes (curated profiles included) are left out.
  const topPicks = useMemo(() => {
    const live = loaded?.live ?? []
    if (live.length < TOP_PICKS_MIN_SPARKS) return null
    return live
      .filter((s): s is SparkEntry & { compatibilityScore: number } => typeof s.compatibilityScore === 'number')
      .sort((a, b) => b.compatibilityScore - a.compatibilityScore)
      .slice(0, TOP_PICKS_COUNT)
  }, [loaded])
  // The tab disappears when the queue drops below the minimum.
  const shownTab: Tab = tab === 'picks' && !topPicks ? 'sparks' : tab
  const sentList = sent?.key === key ? sent.list : null
  const curiousState = curious?.key === key ? curious : null
  const curiousCount = curiousState?.result
    ? curiousState.result.count >= CURIOUS_MAX
      ? `${CURIOUS_MAX}+`
      : String(curiousState.result.count)
    : ''

  const symbol = isPlay ? '🔥' : '✦'
  const TABS: { id: Tab; label: string }[] = [
    { id: 'sparks', label: `${isPlay ? '🔥 Flames' : '✦ Sparks'} ${liveCount}` },
    { id: 'curious', label: `${symbol} Curious${curiousCount ? ` ${curiousCount}` : ''}` },
    ...(topPicks ? [{ id: 'picks' as const, label: `${symbol} Top Picks ${topPicks.length}` }] : []),
    { id: 'sent', label: `→ Sent${sentList ? ` ${sentList.length}` : ''}` },
  ]
  const activeTab = isPlay ? 'border-[#E03131] text-white' : 'border-[#1B4FD8] text-white'

  const profileView = selected && (
    <SparkProfileView
      key={selected.likeId}
      spark={selected}
      onClose={() => setSelected(null)}
      onMatchStart={(name, photo) => setNewMatch({ matchId: null, theirUid: '', theirName: name, theirPhoto: photo, mode: selected.mode })}
      onMatched={(matchId, partnerId) => {
        setNewMatch((m) => (m ? { ...m, matchId, theirUid: partnerId } : m))
        setReload((n) => n + 1)
      }}
      onMatchFailed={() => setNewMatch(null)}
      onDismissed={() => {
        setSelected(null)
        setReload((n) => n + 1)
      }}
    />
  )

  // Free: how many people are interested, never who — curated profiles'
  // likes aside (no paid feature involves a bot).
  if (sparksAllowed === false) {
    const count = loaded ? loaded.count : null
    const curated = loaded ? [...loaded.live, ...loaded.viewed] : []
    return (
      <div className="min-h-[calc(100dvh-7rem)] lg:min-h-[calc(100dvh-7.5rem)] bg-gray-950 px-4 py-8 text-white">
        <PaywallCard
          feature="sparks"
          teaser={
            <div className="flex flex-col items-center gap-3">
              <div className="flex -space-x-3" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className={`h-12 w-12 rounded-full border-2 border-gray-900 blur-[2px] ${
                      isPlay ? 'bg-gradient-to-br from-[#E03131]/70 to-white/20' : 'bg-gradient-to-br from-[#1B4FD8]/70 to-white/20'
                    }`}
                  />
                ))}
              </div>
              {count !== null && count > 0 && (
                <p className="text-sm font-semibold">
                  {count} {count === 1 ? 'person is' : 'people are'} interested in you
                </p>
              )}
            </div>
          }
        />
        {curated.length > 0 && (
          <div className="mx-auto mt-8 max-w-2xl">
            <h2 className="mb-2 text-sm font-semibold text-white/60">From Zylove curated profiles</h2>
            <SparksList sparks={curated} mode={mode} onSelect={setSelected} />
          </div>
        )}
        {profileView}
        {newMatch && <MatchOverlay match={newMatch} onClose={() => setNewMatch(null)} />}
      </div>
    )
  }

  return (
    <div className="min-h-[calc(100dvh-7rem)] lg:min-h-[calc(100dvh-7.5rem)] bg-gray-950 text-white">
      <div className="mx-auto max-w-2xl px-4">
        <header className="flex items-center justify-between py-5">
          <h1 className="text-2xl font-extrabold">{isPlay ? '🔥 Flames 🔥' : '✦ Sparks ✦'}</h1>
          <span className={`text-3xl font-bold ${isPlay ? 'text-[#E03131]' : 'text-[#1B4FD8]'}`}>{liveCount}</span>
        </header>

        <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-white/10 [scrollbar-width:none]">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={shownTab === t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                shownTab === t.id ? activeTab : 'border-transparent text-white/45 hover:text-white/70'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="pb-6">
          {shownTab === 'curious' ? (
            !curiousState ? (
              <Spinner />
            ) : curiousState.error || !curiousState.result ? (
              <LoadError message="Couldn't load who's curious." onRetry={retry} />
            ) : (
              <CuriousList result={curiousState.result} mode={mode} onSelect={(id) => navigate(`/profile/${id}`)} />
            )
          ) : shownTab === 'sent' ? (
            sentList === null ? (
              <Spinner />
            ) : sent?.error ? (
              <LoadError message={`Couldn't load your sent ${isPlay ? 'flames' : 'sparks'}.`} onRetry={retry} />
            ) : (
              <SentList sent={sentList} mode={mode} />
            )
          ) : shownTab === 'picks' && topPicks ? (
            topPicks.length === 0 ? (
              <p className="py-16 text-center text-sm text-white/50">Scores load as you explore. Check back soon.</p>
            ) : (
              <SparksList sparks={topPicks} mode={mode} onSelect={setSelected} topPicks />
            )
          ) : !loaded ? (
            <Spinner />
          ) : loaded.error ? (
            <LoadError message={`Couldn't load your ${isPlay ? 'flames' : 'sparks'}.`} onRetry={retry} />
          ) : (
            <SparksList sparks={loaded.live} mode={mode} onSelect={setSelected} />
          )}
        </div>
      </div>

      {profileView}

      {newMatch && <MatchOverlay match={newMatch} onClose={() => setNewMatch(null)} />}
    </div>
  )
}

// Same "Try again" pattern as Explore's load error.
function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <p className="text-sm text-white/50">{message}</p>
      <button type="button" onClick={onRetry} className="text-sm text-white/40 underline hover:text-white/60">
        Try again
      </button>
    </div>
  )
}

function Spinner() {
  return (
    <div className="flex justify-center py-10">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
    </div>
  )
}
