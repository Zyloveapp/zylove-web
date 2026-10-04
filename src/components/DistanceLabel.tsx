import { useEffect, useState } from 'react'
import { useAuthStore } from '../store/authStore'
import { coordsOf, distanceText, getDistanceMiles, type LatLng } from '../services/location'
import { fetchPublicUserDoc } from '../services/publicUserDoc'

// How far away a profile is from the viewer ("12 miles away"), falling back
// to their city label ("Austin, TX") when either side has no location.
// Snapshot profiles (Sparks cards) often lack coordinates, so with a uid the
// profile's own users/{uid} doc is read (cached, shared with the badges).
// Renders nothing when there's neither. Your own profile shows its label.
// Curated profiles (bots, uid prefix 'zbot-') are all seeded in one city, so
// a real distance to them would mislead ("1,480 miles away"): they show only
// their city label, and only to viewers within BOT_LOCAL_MILES of it.

const BOT_LOCAL_MILES = 50

function isBot(profile: { uid?: string; isBot?: unknown }): boolean {
  return profile.isBot === true || !!profile.uid?.startsWith('zbot-')
}

function useCoords(uid: string | undefined, inline: LatLng | null): LatLng | null | undefined {
  const [fetched, setFetched] = useState<{ uid: string; coords: LatLng | null } | null>(null)
  useEffect(() => {
    if (inline || !uid) return
    let cancelled = false
    fetchPublicUserDoc(uid).then((d) => !cancelled && setFetched({ uid, coords: coordsOf(d) }))
    return () => {
      cancelled = true
    }
  }, [uid, inline])
  if (inline) return inline
  if (!uid) return null
  return fetched?.uid === uid ? fetched.coords : undefined // undefined = loading
}

// Miles between the viewer and a profile, or null while loading or when
// either side has no location.
export function useDistanceMiles(uid: string): number | null {
  const viewerUid = useAuthStore((s) => s.user?.uid)
  const theirs = useCoords(uid, null)
  const mine = useCoords(viewerUid, null)
  if (!theirs || !mine) return null
  return getDistanceMiles(mine.lat, mine.lng, theirs.lat, theirs.lng)
}

export function useDistanceText(profile: { uid?: string; locationLabel?: string; isBot?: unknown }): string | null {
  const viewerUid = useAuthStore((s) => s.user?.uid)
  const self = !!viewerUid && profile.uid === viewerUid
  const theirs = useCoords(self ? undefined : profile.uid, coordsOf(profile))
  const mine = useCoords(self ? undefined : viewerUid, null)
  const label = profile.locationLabel?.trim() || null
  if (self) return label
  if (isBot(profile)) {
    return theirs && mine && getDistanceMiles(mine.lat, mine.lng, theirs.lat, theirs.lng) <= BOT_LOCAL_MILES ? label : null
  }
  if (!theirs || !mine) return label
  return distanceText(getDistanceMiles(mine.lat, mine.lng, theirs.lat, theirs.lng))
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
