import { useEffect, useState } from 'react'
import { fetchPublicUserDoc } from '../services/publicUserDoc'

// "✦ Austin Founder", "✦ NYC Founder": the founderBadge set by
// assignFounderBadge. Founders from before city circles, and founder-code
// ones, have no founderBadge; they get a plain "Founder" rather than a
// guessed city.
export function founderBadgeLabel(profile: object): string | null {
  const p = profile as Record<string, unknown>
  if (p.isFounder !== true) return null
  return typeof p.founderBadge === 'string' && p.founderBadge ? p.founderBadge : 'Founder'
}

export default function FounderBadge({ profile }: { profile: object }) {
  const label = founderBadgeLabel(profile)
  if (!label) return null
  return (
    <span className="inline-block rounded-full border border-[#1B4FD8]/30 bg-[#1B4FD8]/20 px-3 py-1 text-xs font-semibold text-[#6B8FFF]">
      ✦ {label}
    </span>
  )
}

// For lists built from snapshots (sparks) that don't carry founder fields.
export function UserFounderBadge({ uid }: { uid: string }) {
  const [loaded, setLoaded] = useState<{ uid: string; profile: object | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchPublicUserDoc(uid).then((profile) => {
      if (!cancelled) setLoaded({ uid, profile })
    })
    return () => {
      cancelled = true
    }
  }, [uid])

  return loaded?.uid === uid && loaded.profile ? (
    <span className="mt-1 block">
      <FounderBadge profile={loaded.profile} />
    </span>
  ) : null
}
