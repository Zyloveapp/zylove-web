import { useCallback, useEffect, useState } from 'react'
import { subscribeAccountView } from '../services/subscription'
import { Navigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useBackLinkClass, useModeStore } from '../store/modeStore'
import {
  getFounderThread,
  markFounderThreadRead,
  parseThreadMeta,
  sendFounderMessage,
  type FounderMessage,
} from '../services/founderMessages'
import { FounderComposer, FounderThreadView } from '../components/founder/FounderThread'
import { useGoBack } from '../hooks/useGoBack'

type Founder = { uid: string; isFounder: boolean; lastMessageAt: number | null; hasUnread: boolean }

// /founder-messages: a founder's thread with Matthew. Follows
// users/{uid}.founderThreadMeta live, so a reply shows up (and is marked
// read) while the page is open.
export default function FounderMessages() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const mode = useModeStore((s) => s.mode)
  const backLinkClass = useBackLinkClass()
  const goBack = useGoBack('/settings')
  const [founder, setFounder] = useState<Founder | null>(null)
  const [messages, setMessages] = useState<FounderMessage[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!uid) return
    // The account view: the public doc plus private/account, where founder
    // status and the thread summary live (Stage B).
    return subscribeAccountView(
      uid,
      (d) => {
        const meta = parseThreadMeta(d.founderThreadMeta)
        setFounder({ uid, isFounder: d.isFounder === true, lastMessageAt: meta?.lastMessageAt ?? null, hasUnread: meta?.hasUnread === true })
      },
      () => setError(true),
    )
  }, [uid])

  const load = useCallback(() => {
    getFounderThread()
      .then((m) => {
        setMessages(m)
        setError(false)
      })
      .catch(() => setError(true))
  }, [])

  const current = founder?.uid === uid ? founder : null
  const isFounder = current?.isFounder === true
  const lastMessageAt = current?.lastMessageAt ?? null
  const hasUnread = current?.hasUnread === true

  // Reload whenever the thread moves on (a reply, or our own send).
  useEffect(() => {
    if (isFounder) load()
  }, [isFounder, lastMessageAt, load])

  // Opening the page reads everything.
  useEffect(() => {
    if (isFounder && hasUnread) void markFounderThreadRead().catch(() => {})
  }, [isFounder, hasUnread])

  if (current && !current.isFounder) return <Navigate to="/settings" replace />

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-7rem)] max-w-xl flex-col bg-gray-950 text-white">
      <div className="flex items-center gap-3 px-4 pt-6">
        <button type="button" onClick={goBack} className={`text-sm font-medium ${backLinkClass} hover:text-white`}>
          ← Back
        </button>
        <h1 className="text-xl font-bold">Messages from the Founder</h1>
      </div>

      <div className="flex-1">
        {error && messages === null ? (
          <p className="px-6 py-12 text-center text-sm text-red-400">Couldn't load your messages.</p>
        ) : messages === null ? (
          <div className="mx-auto mt-12 h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        ) : (
          <FounderThreadView
            messages={messages}
            viewer="founder"
            bubble={mode === 'play' ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'}
            empty="No messages yet. Send the founder a message — every message is read personally."
          />
        )}
      </div>

      {isFounder && (
        <FounderComposer
          placeholder="Share your thoughts..."
          button="Send ✦"
          onSend={async (body) => {
            await sendFounderMessage(body)
            load()
          }}
        />
      )}
    </div>
  )
}
