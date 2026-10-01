import { useEffect, useState } from 'react'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../../services/firebase'
import type { DiscoverProfile } from '../../services/discover'
import type { MatchEntry } from '../../services/matches'
import ProfileDetails from '../discover/ProfileDetails'
import PhotoGallery from '../discover/PhotoGallery'

type Loaded = { uid: string; profile: DiscoverProfile | null }

// Chat ••• → "View compatibility": the linked person's full profile and
// compatibility report (as in the Spark profile view), ending with a
// "Break the ice" opener.
export default function MatchProfileView({ match, onClose }: { match: MatchEntry; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    let cancelled = false
    getDoc(doc(db, 'users', match.partnerUid))
      .then((snap) => (snap.exists() ? { ...(snap.data() as DiscoverProfile), uid: match.partnerUid } : null))
      .catch(() => null)
      .then((profile) => {
        if (!cancelled) setLoaded({ uid: match.partnerUid, profile })
      })
    return () => {
      cancelled = true
    }
  }, [match.partnerUid])

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const current = loaded?.uid === match.partnerUid ? loaded : null

  return (
    <div className="fixed inset-0 z-[55] flex flex-col bg-gray-950 text-white" role="dialog" aria-modal="true" aria-label="Compatibility">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3 lg:px-6">
        <button type="button" onClick={onClose} className="text-sm text-white/60 hover:text-white">
          ← Back to chat
        </button>
        <span className="text-sm text-white/40">✦ You and {match.name}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {current === null ? (
          <div className="flex justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          </div>
        ) : current.profile === null ? (
          <p className="py-16 text-center text-sm text-white/50">This profile isn't available.</p>
        ) : (
          <div className="mx-auto max-w-3xl px-6 py-8">
            <div className="mb-8 max-w-sm">
              <PhotoGallery photos={current.profile.photoURLs ?? []} name={match.name} />
            </div>
            <ProfileDetails profile={current.profile} mode={match.mode} autoRevealScore match={{ matchId: match.matchId }} />
          </div>
        )}
      </div>
    </div>
  )
}
