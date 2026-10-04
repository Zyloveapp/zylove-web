import { useEffect, useState } from 'react'
import { useAuthStore } from '../store/authStore'
import { coordsOf, distanceText, getDistanceMiles, type LatLng } from '../services/location'
import { fetchPublicUserDoc } from '../services/publicUserDoc'

// How far away a profile is from the viewer ("12 miles away"), falling back
// to their city label ("Austin, TX") when either side has no location.
// Snapshot profiles (Sparks cards) often lack coordinates, so with a uid the
// profile's own users/{uid} doc is read (cached, shared with the badges).
// Renders nothing when there's neither. Your own profile shows its label.

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

export function useDistanceText(profile: { uid?: string; locationLabel?: string }): string | null {
  const viewerUid = useAuthStore((s) => s.user?.uid)
  const self = !!viewerUid && profile.uid === viewerUid
  const theirs = useCoords(self ? undefined : profile.uid, coordsOf(profile))
  const mine = useCoords(self ? undefined : viewerUid, null)
  const label = profile.locationLabel?.trim() || null
  if (self || !theirs || !mine) return label
  return distanceText(getDistanceMiles(mine.lat, mine.lng, theirs.lat, theirs.lng))
}

export default function DistanceLabel({
  profile,
  className,
  prefix = '📍 ',
}: {
  profile: { uid?: string; locationLabel?: string }
  className?: string
  prefix?: string
}) {
  const text = useDistanceText(profile)
  return text ? <span className={className}>{`${prefix}${text}`}</span> : null
}
