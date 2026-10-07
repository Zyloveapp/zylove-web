import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  FOUNDER_MESSAGE_MAX,
  broadcastToFounders,
  getFounderThread,
  getFounderThreads,
  replyToFounder,
  timeSince,
  type FounderMessage,
  type FounderThreadSummary,
} from '../../services/founderMessages'
import { FounderComposer, FounderThreadView } from '../../components/founder/FounderThread'

// Unread first, then newest.
function sortThreads(threads: FounderThreadSummary[]): FounderThreadSummary[] {
  return [...threads].sort((a, b) => Number(b.hasUnread) - Number(a.hasUnread) || (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
}

// /admin/messages: every founder thread; ?founder=<uid> opens one.
export default function AdminMessages() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const openUid = searchParams.get('founder')
  const [threads, setThreads] = useState<FounderThreadSummary[] | null>(null)
  const [founderCount, setFounderCount] = useState(0)
  const [error, setError] = useState(false)
  const [broadcastOpen, setBroadcastOpen] = useState(false)

  const loadThreads = useCallback(() => {
    getFounderThreads()
      .then(({ threads, founderCount }) => {
        setThreads(sortThreads(threads))
        setFounderCount(founderCount)
        setError(false)
      })
      .catch(() => setError(true))
  }, [])

  useEffect(() => {
    if (!openUid) loadThreads()
  }, [openUid, loadThreads])

  const open = openUid ? threads?.find((t) => t.uid === openUid) ?? null : null
  if (openUid) {
    return <ThreadPage founderUid={openUid} summary={open} onBack={() => setSearchParams({})} />
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-6 text-white">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate(-1)} className="text-sm font-medium text-[#7C9BFF] hover:text-white">
            ← Back
          </button>
          <h1 className="text-xl font-bold">Founder Messages</h1>
        </div>
        <button
          type="button"
          onClick={() => setBroadcastOpen(true)}
          disabled={threads === null}
          className="rounded-xl bg-[#1B4FD8] px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40"
        >
          Message all founders →
        </button>
      </div>

      {error && <p className="mt-8 text-center text-sm text-red-400">Couldn't load founder messages.</p>}
      {!error && threads === null && <div className="mx-auto mt-12 h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />}
      {threads?.length === 0 && <p className="mt-12 text-center text-sm text-white/50">No founder messages yet.</p>}
      {threads && threads.length > 0 && (
        <ul className="mt-6 divide-y divide-white/5 overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          {threads.map((t) => (
            <li key={t.uid}>
              <button
                type="button"
                onClick={() => setSearchParams({ founder: t.uid })}
                className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-white/[0.04]"
              >
                <span className={`mt-2 h-2 w-2 shrink-0 rounded-full ${t.hasUnread ? 'bg-[#E03131]' : 'bg-transparent'}`} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className={`font-medium ${t.hasUnread ? 'text-white' : 'text-white/80'}`}>{t.displayName}</span>
                    {t.founderBadge && (
                      <span className="rounded-full border border-[#1B4FD8]/30 bg-[#1B4FD8]/20 px-2 py-0.5 text-[11px] font-semibold text-[#6B8FFF]">
                        {t.founderBadge}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-sm text-white/50">{t.lastMessagePreview}</span>
                </span>
                <span className="shrink-0 text-xs text-white/40">{timeSince(t.lastMessageAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {broadcastOpen && (
        <BroadcastModal
          founderCount={founderCount}
          onClose={() => {
            setBroadcastOpen(false)
            loadThreads()
          }}
        />
      )}
    </div>
  )
}

function ThreadPage({
  founderUid,
  summary,
  onBack,
}: {
  founderUid: string
  summary: FounderThreadSummary | null
  onBack: () => void
}) {
  const [messages, setMessages] = useState<FounderMessage[] | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(() => {
    getFounderThread(founderUid)
      .then((m) => {
        setMessages(m)
        setError(false)
      })
      .catch(() => setError(true))
  }, [founderUid])

  useEffect(load, [load])

  // The summary isn't loaded on a direct link; the founder's name is on
  // their messages.
  const name = summary?.displayName ?? messages?.find((m) => !m.isFromAdmin)?.fromName ?? 'founder'

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-7rem)] max-w-xl flex-col text-white">
      <div className="flex items-center gap-3 px-4 pt-6">
        <button type="button" onClick={onBack} className="text-sm font-medium text-[#7C9BFF] hover:text-white">
          ← Inbox
        </button>
        <h1 className="text-xl font-bold">{name}</h1>
        {summary?.founderBadge && <span className="text-xs text-[#6B8FFF]">{summary.founderBadge}</span>}
      </div>
      <div className="flex-1">
        {error ? (
          <p className="px-6 py-12 text-center text-sm text-red-400">Couldn't load this thread.</p>
        ) : messages === null ? (
          <div className="mx-auto mt-12 h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        ) : (
          <FounderThreadView messages={messages} viewer="admin" bubble="bg-[#1B4FD8]" empty="No messages in this thread yet." />
        )}
      </div>
      <FounderComposer
        placeholder={`Reply to ${name}...`}
        button="Send ✦"
        onSend={async (body) => {
          await replyToFounder(founderUid, body)
          load()
        }}
      />
    </div>
  )
}

function BroadcastModal({ founderCount, onClose }: { founderCount: number; onClose: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ sent: number; total: number; texted: number } | null>(null)
  const trimmed = text.trim()

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  async function send() {
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      setResult(await broadcastToFounders(trimmed))
    } catch {
      setError("Couldn't send the broadcast. Nothing may have gone out — check the inbox before retrying.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="broadcast-title"
    >
      <div className="w-full rounded-t-2xl bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-md lg:rounded-2xl lg:pb-6">
        <h2 id="broadcast-title" className="text-xl font-bold">
          Message all {founderCount} founders
        </h2>
        {result ? (
          <>
            <p className="mt-4 text-emerald-300">
              ✦ Sent to {result.sent} of {result.total} founders.
            </p>
            <p className="mt-1 text-sm text-white/50">In their founder threads — broadcasts aren't texted.</p>
            <button type="button" onClick={onClose} className="mt-6 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold text-white">
              Done
            </button>
          </>
        ) : (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, FOUNDER_MESSAGE_MAX))}
              placeholder="Write your message..."
              rows={6}
              maxLength={FOUNDER_MESSAGE_MAX}
              disabled={busy}
              autoFocus
              className="mt-4 w-full resize-none rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-[#1B4FD8]/60 focus:outline-none"
            />
            <p className="mt-1 text-right text-xs text-white/40">
              {text.length}/{FOUNDER_MESSAGE_MAX}
            </p>
            <p className="mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              This will send to all active founders and SMS those with notifications on.
            </p>
            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
            <button
              type="button"
              onClick={() => void send()}
              disabled={!trimmed || busy}
              className="mt-5 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy ? `Sending to ${founderCount} founders…` : 'Send to all founders ✦'}
            </button>
            <button type="button" onClick={onClose} disabled={busy} className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white">
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  )
}
