import { useEffect, useMemo, useState } from 'react'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import SparksList, { SentList, TopPicksList } from '../components/matches/SparksList'
import SparkProfileView from '../components/matches/SparkProfileView'
import TopPickView from '../components/matches/TopPickView'
import MatchOverlay, { type NewMatch } from '../components/discover/MatchOverlay'
import { subscribeMatches, type MatchEntry } from '../services/matches'
import { fetchSentSparks, subscribeSparkQueue, type SentSpark, type SparkEntry } from '../services/sparks'
import { displayScore, fetchCompatibility, fetchTopPicks, type TopPick } from '../services/discover'

type Tab = 'sparks' | 'viewed' | 'picks' | 'sent'

interface QueueState {
  key: string
  live: SparkEntry[]
  viewed: SparkEntry[]
  error: boolean
}

// Sparks (Spark) / Flames (Play): people who liked you, the ones you passed
// on, and Top Picks from Explore.
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
  const [picks, setPicks] = useState<{ key: string; list: TopPick[] | null; error: boolean } | null>(null)
  const [sent, setSent] = useState<{ key: string; list: SentSpark[] | null; error: boolean } | null>(null)
  const [selected, setSelected] = useState<SparkEntry | null>(null)
  // Calculated scores for sparks opened this session, keyed by likerUid.
  const [scores, setScores] = useState<{ key: string; map: Map<string, number> }>({ key, map: new Map() })
  const [selectedPick, setSelectedPick] = useState<TopPick | null>(null)
  const [newMatch, setNewMatch] = useState<NewMatch | null>(null)

  useEffect(() => {
    if (!uid) return
    return subscribeSparkQueue(
      uid,
      mode,
      ({ live, viewed }) => setQueue({ key, live, viewed, error: false }),
      () => setQueue({ key, live: [], viewed: [], error: true }),
    )
  }, [uid, mode, key])

  useEffect(() => {
    if (!uid) return
    return subscribeMatches(
      uid,
      mode,
      (list) => setMatches({ key, list }),
      () => setMatches({ key, list: [] }),
    )
  }, [uid, mode, key])

  // Top Picks read one pair doc per Explore candidate, so they load the first
  // time the tab opens (per mode), not with the page.
  const picksLoaded = picks?.key === key
  useEffect(() => {
    if (tab !== 'picks' || picksLoaded || !uid) return
    let cancelled = false
    fetchTopPicks(uid, mode)
      .then((list) => !cancelled && setPicks({ key, list, error: false }))
      .catch(() => !cancelled && setPicks({ key, list: [], error: true }))
    return () => {
      cancelled = true
    }
  }, [tab, picksLoaded, uid, mode, key])

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
  }, [tab, uid, mode, key])

  const matchedUids = useMemo(
    () => new Set(matches?.key === key ? matches.list.map((m) => m.partnerUid) : []),
    [matches, key],
  )

  const loaded = queue?.key === key ? queue : null
  const pickList = picks?.key === key ? picks.list : null
  const liveCount = loaded?.live.length ?? 0
  const sentList = sent?.key === key ? sent.list : null

  const TABS: { id: Tab; label: string }[] = [
    { id: 'sparks', label: `${isPlay ? '🔥 Flames' : '✦ Sparks'} ${liveCount}` },
    { id: 'viewed', label: `◎ Viewed · ${loaded?.viewed.length ?? 0}` },
    { id: 'picks', label: `✦ Top Picks${pickList ? ` ${pickList.length}` : ''}` },
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

  return (
    <div className="min-h-[calc(100dvh-7rem)] bg-gray-950 text-white">
      <div className="mx-auto max-w-2xl px-4">
        <header className="flex items-center justify-between py-5">
          <h1 className="text-2xl font-extrabold">{isPlay ? '🔥 Flames ✦' : '✦ Sparks ✦'}</h1>
          <span className={`text-3xl font-bold ${isPlay ? 'text-[#E03131]' : 'text-[#1B4FD8]'}`}>{liveCount}</span>
        </header>

        <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-white/10 [scrollbar-width:none]">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                tab === t.id ? activeTab : 'border-transparent text-white/45 hover:text-white/70'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="pb-6">
          {tab === 'sent' ? (
            sentList === null ? (
              <Spinner />
            ) : sent?.error ? (
              <p className="py-10 text-center text-sm text-white/50">Couldn't load your sent {isPlay ? 'flames' : 'sparks'}.</p>
            ) : (
              <SentList sent={sentList} mode={mode} />
            )
          ) : tab === 'picks' ? (
            pickList === null ? (
              <Spinner />
            ) : picks?.error ? (
              <p className="py-10 text-center text-sm text-white/50">Couldn't load Top Picks.</p>
            ) : (
              <TopPicksList picks={pickList} mode={mode} onSelect={setSelectedPick} />
            )
          ) : !loaded ? (
            <Spinner />
          ) : loaded.error ? (
            <p className="py-10 text-center text-sm text-white/50">Couldn't load your {isPlay ? 'flames' : 'sparks'}.</p>
          ) : (
            <SparksList
              sparks={tab === 'viewed' ? loaded.viewed : loaded.live}
              mode={mode}
              matchedUids={matchedUids}
              onSelect={openSpark}
              variant={tab === 'viewed' ? 'viewed' : 'live'}
              scores={scores.key === key ? scores.map : undefined}
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
          onMatchStart={(name) =>
            setNewMatch({
              matchId: null,
              theirUid: selected.likerUid,
              theirName: name,
              theirPhoto: selected.profile.photoURLs?.[0] ?? null,
              mode: selected.mode,
            })
          }
          onMatched={(matchId) => setNewMatch((m) => (m ? { ...m, matchId } : m))}
          onMatchFailed={() => setNewMatch(null)}
        />
      )}

      {selectedPick && (
        <TopPickView
          key={selectedPick.profile.uid}
          uid={uid}
          pick={selectedPick}
          mode={mode}
          onClose={() => setSelectedPick(null)}
          onDone={({ matchId }) => {
            const p = selectedPick.profile
            setSelectedPick(null)
            setPicks((prev) => (prev?.list ? { ...prev, list: prev.list.filter((x) => x.profile.uid !== p.uid) } : prev))
            if (matchId) {
              setNewMatch({
                matchId,
                theirUid: p.uid,
                theirName: p.displayName ?? 'Someone',
                theirPhoto: p.photoURLs?.[0] ?? null,
                mode,
              })
            }
          }}
        />
      )}

      {newMatch && <MatchOverlay match={newMatch} />}
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
