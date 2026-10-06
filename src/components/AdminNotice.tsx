import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { doc, onSnapshot, serverTimestamp, updateDoc } from 'firebase/firestore'
import { db } from '../services/firebase'
import { useAuthStore } from '../store/authStore'

interface Notice {
  id: string
  type: 'warning' | 'thanks'
  message: string
}

// adminNotice, set by the moderation team (adminModerate): a warning or a
// thank-you, shown once until dismissed. It lives in the owner-only
// users/{uid}/private/account (F-040); older ones on the public doc count
// until migrated.
const accountDoc = (uid: string) => doc(db, 'users', uid, 'private', 'account')
function parseNotice(v: unknown): Notice | null {
  if (typeof v !== 'object' || v === null) return null
  const n = v as Record<string, unknown>
  if (n.seenAt != null || typeof n.message !== 'string' || typeof n.id !== 'string') return null
  return { id: n.id, type: n.type === 'thanks' ? 'thanks' : 'warning', message: n.message }
}

export default function AdminNotice() {
  const uid = useAuthStore((s) => s.user?.uid) ?? null
  const [notice, setNotice] = useState<{ uid: string; notice: Notice; where: 'account' | 'root' } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!uid) return
    let fromAccount: Notice | null = null
    let fromRoot: Notice | null = null
    const emit = () =>
      setNotice(fromAccount ? { uid, notice: fromAccount, where: 'account' } : fromRoot ? { uid, notice: fromRoot, where: 'root' } : null)
    const offs = [
      onSnapshot(accountDoc(uid), (snap) => ((fromAccount = parseNotice(snap.data()?.adminNotice)), emit()), () => {}),
      onSnapshot(doc(db, 'users', uid), (snap) => ((fromRoot = parseNotice(snap.data()?.adminNotice)), emit()), () => {}),
    ]
    return () => offs.forEach((off) => off())
  }, [uid])

  const current = notice?.uid === uid ? notice.notice : null
  if (!uid || !current) return null
  const warning = current.type === 'warning'

  async function dismiss() {
    if (!uid) return
    setBusy(true)
    const ref = notice?.where === 'root' ? doc(db, 'users', uid) : accountDoc(uid)
    await updateDoc(ref, { 'adminNotice.seenAt': serverTimestamp() }).catch(() => setBusy(false))
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[85] flex items-end justify-center bg-black/70 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-notice-title"
    >
      <div
        className={`w-full rounded-t-2xl border bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-md lg:rounded-2xl lg:pb-6 ${
          warning ? 'border-amber-500/40' : 'border-[#1B4FD8]/40'
        }`}
      >
        <h2 id="admin-notice-title" className={`text-xl font-bold ${warning ? 'text-amber-200' : 'text-white'}`}>
          {warning ? '⚠ A note about your account' : '✦ A note from the Zylove team'}
        </h2>
        <p className="mt-3 whitespace-pre-wrap text-sm text-white/70">{current.message}</p>
        <button
          type="button"
          onClick={() => void dismiss()}
          disabled={busy}
          autoFocus
          className={`mt-6 w-full rounded-xl py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50 ${
            warning ? 'bg-amber-600' : 'bg-[#1B4FD8]'
          }`}
        >
          {warning ? 'I understand' : 'Thank you ✦'}
        </button>
      </div>
    </div>,
    document.body,
  )
}
