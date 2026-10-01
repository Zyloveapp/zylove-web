import { useEffect, useState } from 'react'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../services/firebase'

// Public Zylove Score outcome: users/{uid}.zyloveScoreTier, written by
// submitReview. Only Trusted and Elite are ever shown to anyone.
export type BadgeTier = 'trusted' | 'elite'

export function badgeTier(tier: unknown): BadgeTier | null {
  return tier === 'trusted' || tier === 'elite' ? tier : null
}

export default function TierBadge({ tier }: { tier: unknown }) {
  const t = badgeTier(tier)
  if (!t) return null
  return t === 'elite' ? (
    <span className="inline-block shrink-0 rounded-full border border-amber-500/30 bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-400">
      ✦ Elite
    </span>
  ) : (
    <span className="inline-block shrink-0 rounded-full border border-[#1B4FD8]/30 bg-[#1B4FD8]/20 px-2 py-0.5 text-xs font-semibold text-[#6B8FFF]">
      🛡 Trusted
    </span>
  )
}

// One read per uid per session, shared by every row that shows the badge.
const tierCache = new Map<string, Promise<BadgeTier | null>>()

function fetchTier(uid: string): Promise<BadgeTier | null> {
  let request = tierCache.get(uid)
  if (!request) {
    request = getDoc(doc(db, 'users', uid))
      .then((snap) => badgeTier(snap.data()?.zyloveScoreTier))
      .catch(() => null)
    tierCache.set(uid, request)
  }
  return request
}

// For lists built from snapshots (matches, sparks) that don't carry the tier.
export function UserTierBadge({ uid }: { uid: string }) {
  const [loaded, setLoaded] = useState<{ uid: string; tier: BadgeTier | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchTier(uid).then((tier) => {
      if (!cancelled) setLoaded({ uid, tier })
    })
    return () => {
      cancelled = true
    }
  }, [uid])

  return loaded?.uid === uid ? <TierBadge tier={loaded.tier} /> : null
}
