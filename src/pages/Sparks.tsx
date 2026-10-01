import { useEffect, useMemo, useState } from 'react'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import SparksList from '../components/matches/SparksList'
import SparkProfileView from '../components/matches/SparkProfileView'
import MatchOverlay, { type NewMatch } from '../components/discover/MatchOverlay'
import { subscribeMatches, type MatchEntry } from '../services/matches'
import { subscribeSparks, type SparkEntry } from '../services/sparks'

interface SparksState {
  key: string
  sparks: SparkEntry[]
  error: boolean
}

export default function Sparks() {
  // AuthGuard guarantees a signed-in user on this route.
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const mode = useModeStore((s) => s.mode)
  const key = `${uid}:${mode}`

  const [state, setState] = useState<SparksState | null>(null)
  // Matches are only needed to know which likers are already matched.
  const [matches, setMatches] = useState<{ key: string; list: MatchEntry[] } | null>(null)
  const [selected, setSelected] = useState<SparkEntry | null>(null)
  const [newMatch, setNewMatch] = useState<NewMatch | null>(null)

  useEffect(() => {
    if (!uid) return
    return subscribeSparks(
      uid,
      mode,
      (sparks) => setState({ key, sparks, error: false }),
      () => setState({ key, sparks: [], error: true }),
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

  const matchedUids = useMemo(
    () => new Set(matches?.key === key ? matches.list.map((m) => m.partnerUid) : []),
    [matches, key],
  )


  const loaded = state?.key === key ? state : null

  return (
    <div className="flex h-[calc(100dvh-4rem)] lg:h-[calc(100dvh-3.5rem)] bg-gray-950 text-white">
      <aside className="flex w-full shrink-0 flex-col border-white/10 lg:w-80 lg:border-r">
        <h1 className="px-4 py-5 text-xl font-bold text-white">Sparks ✦</h1>
        <div className="flex-1 overflow-y-auto">
          {!loaded ? (
            <div className="flex justify-center py-10">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
            </div>
          ) : loaded.error ? (
            <p className="px-4 text-sm text-white/50">Couldn't load your sparks.</p>
          ) : (
            <SparksList sparks={loaded.sparks} matchedUids={matchedUids} onSelect={setSelected} />
          )}
        </div>
      </aside>

      <main className="hidden flex-1 lg:block">
        <div className="flex h-full items-center justify-center text-white/30">Select a spark to see their profile</div>
      </main>

      {selected && (
        <SparkProfileView
          key={selected.likerUid}
          uid={uid}
          spark={selected}
          matched={matchedUids.has(selected.likerUid)}
          onClose={() => setSelected(null)}
          onMatched={(matchId, name) =>
            setNewMatch({
              matchId,
              theirUid: selected.likerUid,
              theirName: name,
              theirPhoto: selected.profile.photoURLs?.[0] ?? null,
              mode: selected.mode,
            })
          }
        />
      )}

      {newMatch && <MatchOverlay match={newMatch} />}
    </div>
  )
}
