import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import SparksList, { CuriousList, SentList } from '../components/matches/SparksList'
import SparkProfileView from '../components/matches/SparkProfileView'
import MatchOverlay, { type NewMatch } from '../components/discover/MatchOverlay'
import { subscribeMatches, type MatchEntry } from '../services/matches'
import { CURIOUS_MAX, fetchCurious, fetchFreeSparks, fetchSentSparks, subscribeSparkQueue, type CuriousResult, type SentSpark, type SparkEntry } from '../services/sparks'
import { displayScore, fetchCompatibility } from '../services/discover'
import { PaywallCard, useCanAccess } from '../components/PaywallGate'

type Tab = 'sparks' | 'curious' | 'picks' | 'sent'

interface QueueState {
  key: string
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
  // Matches are only needed to know which likers are already matched.
  const [matches, setMatches] = useState<{ key: string; list: MatchEntry[] } | null>(null)
  const [curious, setCurious] = useState<{ key: string; result: CuriousResult | null; error: boolean } | null>(null)
  const navigate = useNavigate()
  const [sent, setSent] = useState<{ key: string; list: SentSpark[] | null; error: boolean } | null>(null)
  const [selected, setSelected] = useState<SparkEntry | null>(null)
  // Calculated scores for sparks opened this session, keyed by likerUid.
  const [scores, setScores] = useState<{ key: string; map: Map<string, number> }>({ key, map: new Map() })
  const [newMatch, setNewMatch] = useState<NewMatch | null>(null)
  const sparksAllowed = useCanAccess('sparks')
  // Bumped by "Try again" to re-run a failed load.
  const [reload, setReload] = useState(0)
  function retry() {
    // Back to the spinner while it reloads.
    setQueue((q) => (q?.error ? null : q))
    setCurious((c) => (c?.error ? null : c))
    setSent((x) => (x?.error ? null : x))
    setReload((n) => n + 1)
  }

  // Free (Stage C): the count of real people, and curated profiles' likes.
  const [freeCount, setFreeCount] = useState<{ key: string; count: number } | null>(null)
  useEffect(() => {
    if (!uid || sparksAllowed !== false) return
    let cancelled = false
    fetchFreeSparks(mode).then(
      ({ count, live, viewed }) => {
        if (cancelled) return
        setFreeCount({ key, count })
        setQueue({ key, live, viewed, error: false })
      },
      () => !cancelled && setQueue({ key, live: [], viewed: [], error: true }),
    )
    return () => {
      cancelled = true
    }
  }, [uid, mode, key, reload, sparksAllowed])

  useEffect(() => {
    if (!uid || sparksAllowed !== true) return
    return subscribeSparkQueue(
      uid,
      mode,
      ({ live, viewed }) => setQueue({ key, live, viewed, error: false }),
      () => setQueue({ key, live: [], viewed: [], error: true }),
    )
  }, [uid, mode, key, reload, sparksAllowed])

  useEffect(() => {
    if (!uid) return
    return subscribeMatches(
      uid,
      mode,
      (list) => setMatches({ key, list }),
      () => setMatches({ key, list: [] }),
    )
  }, [uid, mode, key])


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

  const matchedUids = useMemo(
    () => new Set(matches?.key === key ? matches.list.map((m) => m.partnerUid) : []),
    [matches, key],
  )

  const loaded = queue?.key === key ? queue : null
  const liveCount = loaded?.live.length ?? 0
  const syncedScores = scores.key === key ? scores.map : undefined

  // Bots' likes carry a random placeholder score (see toSpark), so each
  // bot's real score is loaded up front (onTap, cached per session) for its
  // card and the Top Picks ranking.
  const botUids = (loaded?.live ?? []).filter((s) => s.isBot).map((s) => s.likerUid).join(',')
  useEffect(() => {
    if (!botUids) return
    let cancelled = false
    for (const likerUid of botUids.split(',')) {
      fetchCompatibility(likerUid)
        .then((result) => {
          const score = displayScore(result, mode)
          if (cancelled || !score) return
          setScores((prev) => {
            if (prev.key === key && prev.map.get(likerUid) === score.value) return prev
            const map = new Map(prev.key === key ? prev.map : [])
            map.set(likerUid, score.value)
            return { key, map }
          })
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
    }
  }, [botUids, mode, key])

  // Best-matched incoming Sparks: the real score once a card has been opened
  // (and for every bot), otherwise the score saved with the like. Unscored
  // likes — including bots whose score hasn't arrived — are left out.
  const topPicks = useMemo(() => {
    const live = loaded?.live ?? []
    if (live.length < TOP_PICKS_MIN_SPARKS) return null
    return live
      .map((s) => ({ s, score: syncedScores?.get(s.likerUid) ?? s.compatibilityScore }))
      .filter((x): x is { s: SparkEntry; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_PICKS_COUNT)
      .map((x) => x.s)
  }, [loaded, syncedScores])
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

  // Opening a spark loads its real pair score (onTap, shared with the
  // profile's compatibility block) and swaps it into the card.
  function openSpark(spark: SparkEntry) {
    setSelected(spark)
    fetchCompatibility(spark.likerUid)
      .then((result) => {
        const score = displayScore(result, mode)
        if (!score) return
        setScores((prev) => {
          const map = new Map(prev.key === key ? prev.map : [])
          map.set(spark.likerUid, score.value)
          return { key, map }
        })
      })
      .catch(() => {})
  }

  // Free: how many people are interested, never who — curated profiles'
  // likes aside (no paid feature involves a bot).
  if (sparksAllowed === false) {
    const count = freeCount?.key === key ? freeCount.count : null
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
            <SparksList sparks={curated} mode={mode} matchedUids={matchedUids} onSelect={setSelected} scores={syncedScores} />
          </div>
        )}
        {selected && (
          <SparkProfileView
            key={selected.likerUid}
            uid={uid}
            spark={selected}
            matched={matchedUids.has(selected.likerUid)}
            onClose={() => setSelected(null)}
            onMatchStart={(name, photo) =>
              setNewMatch({ matchId: null, theirUid: selected.likerUid, theirName: name, theirPhoto: photo, mode: selected.mode })
            }
            onMatched={(matchId) => setNewMatch((m) => (m ? { ...m, matchId } : m))}
            onMatchFailed={() => setNewMatch(null)}
          />
        )}
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
              <SparksList
                sparks={topPicks}
                mode={mode}
                matchedUids={matchedUids}
                onSelect={openSpark}
                scores={syncedScores}
                topPicks
              />
            )
          ) : !loaded ? (
            <Spinner />
          ) : loaded.error ? (
            <LoadError message={`Couldn't load your ${isPlay ? 'flames' : 'sparks'}.`} onRetry={retry} />
          ) : (
            <SparksList
              sparks={loaded.live}
              mode={mode}
              matchedUids={matchedUids}
              onSelect={openSpark}
              scores={syncedScores}
            />
          )}
        </div>
      </div>

      {selected && (
        <SparkProfileView
          key={selected.likerUid}
          uid={uid}
          spark={selected}
          matched={matchedUids.has(selected.likerUid)}
          onClose={() => setSelected(null)}
          onMatchStart={(name, photo) =>
            setNewMatch({
              matchId: null,
              theirUid: selected.likerUid,
              theirName: name,
              theirPhoto: photo,
              mode: selected.mode,
            })
          }
          onMatched={(matchId) => setNewMatch((m) => (m ? { ...m, matchId } : m))}
          onMatchFailed={() => setNewMatch(null)}
        />
      )}

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
