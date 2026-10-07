import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db } from '../../services/firebase'

// T&S Phase 2 — the safety card, once per person, at their first match with
// a real member. Seen is remembered on this device and in the owner's
// private settings (safetyTipsSeenAt), so it doesn't come back elsewhere.

const TIPS: { icon: string; title: string; body: string }[] = [
  { icon: '💸', title: 'Never send money', body: "Not for a ticket, a bill, an emergency or an investment — and never gift cards. Real matches don't ask." },
  { icon: '🛡', title: 'Never share a code', body: 'A verification code you were texted is the key to an account. Anyone who asks for one is trying to take it.' },
  { icon: '💬', title: 'Keep the chat here', body: "Pressure to move to WhatsApp or Telegram early is a classic scam move. Here, your chats are encrypted and you can report." },
  { icon: '☕', title: 'Meet in public', body: 'First dates somewhere public, tell a friend where you’ll be, and get there and back on your own.' },
  { icon: '🚨', title: 'Report anything off', body: 'Tap ••• in a chat. Reports are confidential and go to a real person.' },
]

const localKey = (uid: string) => `zylove_safety_tips_${uid}`

function seenHere(uid: string): boolean {
  try {
    return localStorage.getItem(localKey(uid)) === '1'
  } catch {
    return true // storage unavailable — don't nag on every visit
  }
}

export default function SafetyTipsCard({ uid, firstMatch }: { uid: string; firstMatch: boolean }) {
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    if (!firstMatch || !uid || seenHere(uid)) return
    let cancelled = false
    getDoc(doc(db, `users/${uid}/private/settings`))
      .then((snap) => {
        if (cancelled) return
        if (typeof snap.data()?.safetyTipsSeenAt === 'number') {
          try {
            localStorage.setItem(localKey(uid), '1')
          } catch {
            // ignore
          }
        } else setOpen(uid)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [uid, firstMatch])

  if (open !== uid) return null

  function dismiss() {
    try {
      localStorage.setItem(localKey(uid), '1')
    } catch {
      // ignore
    }
    setDoc(doc(db, `users/${uid}/private/settings`), { safetyTipsSeenAt: Date.now() }, { merge: true }).catch(() => {})
    setOpen(null)
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="safety-tips-title"
    >
      <div className="max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl border border-white/10 bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-md lg:rounded-2xl lg:pb-6">
        <h2 id="safety-tips-title" className="text-xl font-bold">
          You've got a match ✦ A few things before you chat
        </h2>
        <ul className="mt-4 space-y-3">
          {TIPS.map((t) => (
            <li key={t.title} className="flex gap-3">
              <span className="text-xl" aria-hidden>
                {t.icon}
              </span>
              <span>
                <span className="block font-semibold">{t.title}</span>
                <span className="block text-sm text-white/60">{t.body}</span>
              </span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={dismiss}
          autoFocus
          className="mt-6 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold text-white transition-opacity hover:opacity-90"
        >
          Got it
        </button>
      </div>
    </div>,
    document.body,
  )
}
