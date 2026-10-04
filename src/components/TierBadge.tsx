import { useEffect, useState } from 'react'
import { fetchPublicUserDoc } from '../services/publicUserDoc'

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

function fetchTier(uid: string): Promise<BadgeTier | null> {
  return fetchPublicUserDoc(uid).then((d) => badgeTier(d?.zyloveScoreTier))
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
