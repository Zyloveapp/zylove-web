import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { doc, getDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../services/firebase'
import { useAuthStore } from '../store/authStore'
import { LEGAL_UPDATE, LEGAL_VERSIONS } from '../config/legal'

// The in-app notice for existing users when the Terms or Privacy Policy
// change (Privacy §11, Terms §15). Shown once per version until "Got it",
// which the server records in users/{uid}/legalAcceptance/notice. Anyone who
// accepted the current versions at onboarding (legalAcceptance/main) never
// sees it. The title names only what changed since they last saw it.
type Due = { uid: string; terms: boolean; privacy: boolean }

const TITLE = (d: Due) =>
  d.terms && d.privacy ? "We've updated our Terms and Privacy Policy" : d.terms ? "We've updated our Terms" : "We've updated our Privacy Policy"

export default function LegalUpdateNotice() {
  const uid = useAuthStore((s) => s.user?.uid) ?? null
  const [due, setDue] = useState<Due | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    const ref = (id: string) => doc(db, 'users', uid, 'legalAcceptance', id)
    Promise.all([getDoc(ref('main')), getDoc(ref('notice'))])
      .then(([main, notice]) => {
        const seen = (field: 'termsVersion' | 'privacyVersion', version: string) =>
          main.data()?.[field] === version || notice.data()?.[field] === version
        const terms = !seen('termsVersion', LEGAL_VERSIONS.terms)
        const privacy = !seen('privacyVersion', LEGAL_VERSIONS.privacy)
        if (!cancelled && (terms || privacy)) setDue({ uid, terms, privacy })
      })
      // Unreadable: try again next time rather than nag now.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [uid])

  if (!uid || due?.uid !== uid) return null

  async function acknowledge() {
    setBusy(true)
    // Hidden either way; if recording fails it shows again next visit.
    await httpsCallable(functions, 'acknowledgeLegalUpdate')({}).catch(() => {})
    setDue(null)
    setBusy(false)
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="legal-update-title"
    >
      <div className="w-full rounded-t-2xl border border-[#1B4FD8]/40 bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-md lg:rounded-2xl lg:pb-6">
        <h2 id="legal-update-title" className="text-xl font-bold">
          {TITLE(due)}
        </h2>
        <p className="mt-2 text-sm text-white/60">Updated {LEGAL_UPDATE.updated}. What changed:</p>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-white/80">
          {LEGAL_UPDATE.changes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-white/60">
          Read the{' '}
          <Link to="/terms" target="_blank" rel="noreferrer" className="text-[#7C9BFF] underline hover:text-white">
            Terms
          </Link>
          ,{' '}
          <Link to="/privacy" target="_blank" rel="noreferrer" className="text-[#7C9BFF] underline hover:text-white">
            Privacy Policy
          </Link>{' '}
          and{' '}
          <Link to="/sms-terms" target="_blank" rel="noreferrer" className="text-[#7C9BFF] underline hover:text-white">
            SMS Terms
          </Link>
          . If you keep using Zylove from {LEGAL_UPDATE.effective}, {due.terms ? 'the updated Terms apply' : 'the updated Privacy Policy applies'}. If you don't agree, you can delete
          your account in Settings.
        </p>
        <button
          type="button"
          onClick={() => void acknowledge()}
          disabled={busy}
          autoFocus
          className="mt-6 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Got it
        </button>
      </div>
    </div>,
    document.body,
  )
}
