import { useEffect, useState } from 'react'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import ProfileCard from '../components/discover/ProfileCard'
import {
  actionErrorMessage,
  ensureUserDefaults,
  fetchCandidates,
  likeProfile,
  passProfile,
  type DiscoverProfile,
} from '../services/discover'

type Action = 'like' | 'pass'

interface QueueState {
  key: string
  profiles: DiscoverProfile[]
  error: string | null
}

function Spinner({ className = 'h-8 w-8 border-4 border-gray-300 border-t-gray-800' }: { className?: string }) {
  return <div className={`animate-spin rounded-full ${className}`} />
}

export default function Discover() {
  // AuthGuard guarantees a signed-in user on this route.
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const mode = useModeStore((s) => s.mode)
  const key = `${uid}:${mode}`

  const [queue, setQueue] = useState<QueueState | null>(null)
  const [index, setIndex] = useState(0)
  const [pending, setPending] = useState<Action | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [matchName, setMatchName] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    ensureUserDefaults()
    fetchCandidates(uid, mode)
      .then((profiles) => {
        if (cancelled) return
        setQueue({ key, profiles, error: null })
        setIndex(0)
      })
      .catch(() => {
        if (!cancelled) setQueue({ key, profiles: [], error: "Couldn't load profiles. Check your connection." })
      })
    return () => {
      cancelled = true
    }
  }, [uid, mode, key, reload])

  const loading = queue?.key !== key
  const current = loading ? undefined : queue.profiles[index]
  const likeColor = mode === 'play' ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'

  async function act(action: Action) {
    if (!current || pending) return
    setPending(action)
    setActionError(null)
    try {
      if (action === 'like') {
        const result = await likeProfile(uid, mode, current.uid)
        if (result.matched) setMatchName(current.displayName ?? 'someone')
      } else {
        await passProfile(uid, mode, current.uid)
      }
      setIndex((i) => i + 1)
    } catch (err) {
      setActionError(actionErrorMessage(err))
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="mx-auto flex max-w-sm items-center justify-between px-4 py-4">
        <h1 className="text-xl font-bold">✦ Discover</h1>
        <button
          type="button"
          title="Mode switching is coming soon"
          className="rounded-full border border-gray-300 bg-white px-3 py-1 text-sm font-medium"
        >
          {mode === 'play' ? '🔴 Play' : '🔵 Spark'}
        </button>
      </header>

      <main className="mx-auto max-w-sm px-4 pb-32">
        {matchName && (
          <div className="mb-4 flex items-center justify-between rounded-xl bg-green-50 px-4 py-3 text-sm text-green-900">
            <span>✦ It's a match with {matchName}!</span>
            <button type="button" onClick={() => setMatchName(null)} className="font-medium underline">
              Dismiss
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-24">
            <Spinner />
          </div>
        ) : queue.error ? (
          <div className="py-24 text-center">
            <p className="mb-4 text-gray-700">{queue.error}</p>
            <button
              type="button"
              onClick={() => {
                setQueue(null)
                setReload((n) => n + 1)
              }}
              className="rounded-lg bg-gray-900 px-4 py-2 font-medium text-white"
            >
              Try again
            </button>
          </div>
        ) : current ? (
          <ProfileCard key={current.uid} profile={current} mode={mode} />
        ) : (
          <div className="py-24 text-center">
            <p className="mb-4 text-4xl text-gray-400">✦</p>
            <h2 className="text-xl font-semibold">You've seen everyone for now</h2>
            <p className="mt-2 text-gray-600">Check back tomorrow for new profiles</p>
            <p className="mt-8 text-sm font-semibold tracking-wide text-gray-400">✦ Zylove</p>
          </div>
        )}
      </main>

      {current && (
        <nav className="fixed inset-x-0 bottom-0 border-t border-gray-200 bg-white/95 backdrop-blur">
          <div className="mx-auto max-w-sm px-4 py-4">
            {actionError && <p className="mb-3 text-center text-sm text-red-600">{actionError}</p>}
            <div className="flex items-center justify-center gap-8">
              <button
                type="button"
                onClick={() => act('pass')}
                disabled={pending !== null}
                aria-label="Pass"
                className="flex h-16 w-16 items-center justify-center rounded-full border border-gray-300 bg-white text-2xl text-gray-500 shadow-sm disabled:opacity-50"
              >
                {pending === 'pass' ? <Spinner className="h-6 w-6 border-2 border-gray-300 border-t-gray-800" /> : '✕'}
              </button>
              <button
                type="button"
                onClick={() => act('like')}
                disabled={pending !== null}
                aria-label="Like"
                className={`flex h-16 w-16 items-center justify-center rounded-full text-2xl text-white shadow-md disabled:opacity-50 ${likeColor}`}
              >
                {pending === 'like' ? <Spinner className="h-6 w-6 border-2 border-white/40 border-t-white" /> : '♥'}
              </button>
            </div>
          </div>
        </nav>
      )}
    </div>
  )
}
