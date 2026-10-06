import { useEffect, useState } from 'react'
import { useAuthStore } from '../store/authStore'
import { distanceText } from '../services/location'
import { cachedDistance, getDistance, type Distance } from '../services/distances'

// How far away a profile is from the viewer ("12 miles away"), from the
// server (services/distances), falling back to their city label ("Austin,
// TX") when either side has no saved location. Renders nothing when there's
// neither. Your own profile shows its label.
// Curated profiles (bots, uid prefix 'zbot-') are all seeded in one city, so
// a real distance to them would mislead ("1,480 miles away"): they show only
// their city label, and only to viewers within BOT_LOCAL_MILES of it.

const BOT_LOCAL_MILES = 50

function isBot(profile: { uid?: string; isBot?: unknown }): boolean {
  return profile.isBot === true || !!profile.uid?.startsWith('zbot-')
}

// The viewer's distance to uid: undefined while loading, null if unknown.
function useDistance(uid: string | undefined): Distance | null | undefined {
  const [fetched, setFetched] = useState<{ uid: string; d: Distance | null } | null>(null)
  const cached = uid ? cachedDistance(uid) : null
  useEffect(() => {
    if (!uid || cached !== undefined) return
    let cancelled = false
    void getDistance(uid).then((d) => !cancelled && setFetched({ uid, d }))
    return () => {
      cancelled = true
    }
  }, [uid, cached])
  if (!uid) return null
  if (cached !== undefined) return cached
  return fetched?.uid === uid ? fetched.d : undefined
}

// Miles between the viewer and a profile, or null while loading or when
// either side has no location.
export function useDistanceMiles(uid: string): number | null {
  return useDistance(uid)?.miles ?? null
}

export function useDistanceText(profile: { uid?: string; locationLabel?: string; isBot?: unknown }): string | null {
  const viewerUid = useAuthStore((s) => s.user?.uid)
  const self = !!viewerUid && profile.uid === viewerUid
  const distance = useDistance(self ? undefined : profile.uid)
  const label = profile.locationLabel?.trim() || null
  if (self) return label
  if (isBot(profile)) return distance && distance.miles <= BOT_LOCAL_MILES ? label : null
  if (!distance) return label
  return distanceText(distance.miles)
}

export default function DistanceLabel({
  profile,
  className,
  prefix = '📍 ',
}: {
  profile: { uid?: string; locationLabel?: string; isBot?: unknown }
  className?: string
  prefix?: string
}) {
  const text = useDistanceText(profile)
  return text ? <span className={className}>{`${prefix}${text}`}</span> : null
}
