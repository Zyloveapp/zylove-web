import { useEffect, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../../services/firebase'

const MAX_CALLS = 3

function fetchStarters(matchId: string, otherUid: string): Promise<string[]> {
  // Break the ice is Spark+ (Stage C; the server checks).
  return httpsCallable<{ matchId: string; otherUid: string; source: 'icebreaker' }, { starters: string[] }>(
    functions,
    'generateConversationStarter',
  )({ matchId, otherUid, source: 'icebreaker' }).then(({ data }) => data.starters.filter((s) => s.trim()))
}

// "💬 Break the ice" — an AI opener for someone you're linked with. Each call
// returns three; "Try another" works through those before asking again, with
// at most three calls per view.
export default function BreakTheIce({ matchId, otherUid }: { matchId: string; otherUid: string }) {
  const [starters, setStarters] = useState<string[]>([])
  const [index, setIndex] = useState(0)
  const [calls, setCalls] = useState(1)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchStarters(matchId, otherUid)
      .then((list) => !cancelled && setStarters(list))
      .catch(() => !cancelled && setFailed(true))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [matchId, otherUid])

  async function tryAnother() {
    setCopied(false)
    if (index + 1 < starters.length) return setIndex(index + 1)
    if (calls >= MAX_CALLS) return
    setLoading(true)
    setCalls((c) => c + 1)
    try {
      const fresh = (await fetchStarters(matchId, otherUid)).filter((s) => !starters.includes(s))
      if (fresh.length > 0) {
        setStarters((list) => [...list, ...fresh])
        setIndex(starters.length)
      }
    } catch {
      // Keep showing the current opener.
    } finally {
      setLoading(false)
    }
  }

  async function copy() {
    const text = starters[index]
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // Clipboard blocked — the text is still on screen to copy by hand.
    }
  }

  const current = starters[index]
  const canTryAgain = index + 1 < starters.length || calls < MAX_CALLS

  if (failed && !current) return null

  return (
    <section className="mt-8">
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-white">💬 Break the ice with this...</p>
      <div className="rounded-xl border border-white/10 bg-black/40 p-4">
        {loading && !current ? (
          <p className="text-sm text-white/50">Finding the perfect opener...</p>
        ) : (
          <p className={`text-base italic text-white/90 ${loading ? 'opacity-50' : ''}`}>"{current}"</p>
        )}
      </div>
      {current && (
        <div className="mt-3 flex gap-3">
          <button
            type="button"
            onClick={copy}
            className="rounded-full border border-white/20 px-4 py-1.5 text-sm text-white/80 hover:bg-white/10"
          >
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
          {canTryAgain && (
            <button
              type="button"
              onClick={tryAnother}
              disabled={loading}
              className="rounded-full border border-white/20 px-4 py-1.5 text-sm text-white/80 hover:bg-white/10 disabled:opacity-40"
            >
              {loading ? 'Finding the perfect opener...' : 'Try another'}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
