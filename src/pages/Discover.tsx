import { useEffect, useState } from 'react'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import PhotoGallery from '../components/discover/PhotoGallery'
import ProfileDetails from '../components/discover/ProfileDetails'
import DiscoverActions, { type DiscoverAction } from '../components/discover/DiscoverActions'
import MatchOverlay, { type NewMatch } from '../components/discover/MatchOverlay'
import {
  actionErrorMessage,
  ensureUserDefaults,
  fetchCandidates,
  likeProfile,
  passProfile,
  prefetchCompatibility,
  type DiscoverProfile,
} from '../services/discover'

interface QueueState {
  key: string
  profiles: DiscoverProfile[]
  error: boolean
}

function Spinner() {
  return <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
}

export default function Discover() {
  // AuthGuard guarantees a signed-in user on this route.
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const mode = useModeStore((s) => s.mode)
  const key = `${uid}:${mode}`

  const [queue, setQueue] = useState<QueueState | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [newMatch, setNewMatch] = useState<NewMatch | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    ensureUserDefaults()
    fetchCandidates(uid, mode)
      .then((profiles) => {
        if (!cancelled) setQueue({ key, profiles, error: false })
      })
      .catch(() => {
        if (!cancelled) setQueue({ key, profiles: [], error: true })
      })
    return () => {
      cancelled = true
    }
  }, [uid, mode, key, reload])

  const loading = queue?.key !== key
  const current = loading ? undefined : queue.profiles[0]
  const currentUid = current?.uid

  // Creates the pair doc onLike needs while the user reads the profile.
  useEffect(() => {
    if (currentUid) prefetchCompatibility(currentUid)
  }, [currentUid])

  // Drops the current profile, or moves it to the back of the queue ("Maybe").
  function advance(requeue: boolean) {
    setQueue((q) => {
      if (!q || q.profiles.length === 0) return q
      const [head, ...rest] = q.profiles
      return { ...q, profiles: requeue ? [...rest, head] : rest }
    })
  }

  async function handleAction(action: DiscoverAction) {
    if (!current || busy) return
    setActionError(null)
    if (action === 'maybe') {
      advance(true)
      return
    }
    setBusy(true)
    try {
      if (action === 'interested') {
        const result = await likeProfile(uid, mode, current)
        if (result.matched) {
          setNewMatch({
            matchId: result.matchId ?? [uid, current.uid].sort().join('_'),
            theirUid: current.uid,
            theirName: current.displayName ?? 'Someone',
            theirPhoto: current.photoURLs?.[0] ?? null,
            mode,
          })
        }
      } else {
        await passProfile(uid, mode, current.uid)
      }
      advance(false)
    } catch (err) {
      setActionError(actionErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[calc(100dvh-4rem)] lg:min-h-[calc(100dvh-3.5rem)] items-center justify-center bg-gray-950">
        <Spinner />
      </div>
    )
  }

  if (queue.error) {
    return (
      <div className="flex min-h-[calc(100dvh-4rem)] lg:min-h-[calc(100dvh-3.5rem)] flex-col items-center justify-center gap-3 bg-gray-950 text-white">
        <p className="text-white/70">Couldn't load profiles</p>
        <button
          type="button"
          onClick={() => {
            setQueue(null)
            setReload((n) => n + 1)
          }}
          className="text-sm text-white/40 underline hover:text-white/60"
        >
          Try again
        </button>
      </div>
    )
  }

  if (!current) {
    return (
      <div className="flex min-h-[calc(100dvh-4rem)] lg:min-h-[calc(100dvh-3.5rem)] flex-col items-center justify-center bg-gray-950 px-6 text-center text-white">
        <span className="mb-6 text-6xl text-[#1B4FD8]">✦</span>
        <h1 className="text-2xl font-semibold">You've seen everyone for now</h1>
        <p className="mt-3 text-white/50">New profiles appear as people join. Check back soon.</p>
      </div>
    )
  }

  const name = current.displayName ?? 'Someone'
  const actions = <DiscoverActions mode={mode} busy={busy} error={actionError} onAction={handleAction} />

  return (
    <div className="min-h-[calc(100dvh-4rem)] lg:min-h-[calc(100dvh-3.5rem)] bg-gray-950 text-white lg:flex">
      <aside className="flex flex-col p-6 lg:sticky lg:top-14 lg:h-[calc(100dvh-3.5rem)] lg:w-96 lg:shrink-0 lg:overflow-y-auto lg:py-10">
        <PhotoGallery key={current.uid} photos={current.photoURLs ?? []} name={name} />
        <div className="mt-8 hidden lg:block">{actions}</div>
      </aside>

      <main className="flex-1 px-6 pb-8 lg:px-12 lg:py-10">
        <ProfileDetails profile={current} mode={mode} />
      </main>

      <div className="px-6 pb-10 lg:hidden">{actions}</div>

      {newMatch && <MatchOverlay match={newMatch} />}
    </div>
  )
}
