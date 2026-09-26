import { useState } from 'react'
import { PERSONALITY_TRAIT_LABELS, type PersonalityTrait } from '../../types/profile'
import { displayAge, type DiscoverProfile } from '../../services/discover'
import type { Mode } from '../../store/modeStore'

const BIO_PREVIEW_CHARS = 140

function traitLabel(t: string): string {
  return PERSONALITY_TRAIT_LABELS[t as PersonalityTrait] ?? t.replace(/_/g, ' ')
}

export default function ProfileCard({ profile, mode }: { profile: DiscoverProfile; mode: Mode }) {
  const photos = profile.photoURLs ?? []
  const [photoIndex, setPhotoIndex] = useState(0)
  const [bioExpanded, setBioExpanded] = useState(false)

  const age = displayAge(profile)
  const bio = profile.bio?.trim() ?? ''
  const traits = (profile.personalityTraits ?? []).slice(0, 3)
  const bioIsLong = bio.length > BIO_PREVIEW_CHARS

  return (
    <article className="overflow-hidden rounded-2xl bg-white shadow-lg ring-1 ring-gray-100">
      <div className="relative">
        <button
          type="button"
          onClick={() => photos.length > 1 && setPhotoIndex((i) => (i + 1) % photos.length)}
          className="block w-full"
          aria-label={photos.length > 1 ? 'Next photo' : undefined}
        >
          <img
            src={photos[photoIndex]}
            alt={`${profile.displayName ?? 'Profile'} photo ${photoIndex + 1}`}
            className="aspect-[4/3] w-full rounded-2xl object-cover"
          />
        </button>

        <span
          className={`absolute left-3 top-3 rounded-full px-2.5 py-1 text-xs font-semibold text-white ${
            mode === 'play' ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'
          }`}
        >
          {mode === 'play' ? '🔴 Play' : '🔵 Spark'}
        </span>

        {photos.length > 1 && (
          <div className="absolute inset-x-0 bottom-3 flex justify-center gap-1.5">
            {photos.map((url, i) => (
              <button
                key={url}
                type="button"
                onClick={() => setPhotoIndex(i)}
                aria-label={`Photo ${i + 1}`}
                className={`h-2 w-2 rounded-full ${i === photoIndex ? 'bg-white' : 'bg-white/50'}`}
              />
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2 p-4">
        <h2 className="text-2xl font-bold">
          {profile.displayName ?? 'Someone'}
          {age !== null && <span className="font-normal">, {age}</span>}
        </h2>
        {profile.locationLabel && <p className="text-sm text-gray-500">📍 {profile.locationLabel}</p>}

        {bio && (
          <p className="text-gray-700">
            <span className={bioExpanded ? '' : 'line-clamp-3'}>{bio}</span>
            {bioIsLong && (
              <button
                type="button"
                onClick={() => setBioExpanded((v) => !v)}
                className="ml-1 text-sm font-medium text-gray-900 underline"
              >
                {bioExpanded ? 'less' : 'more'}
              </button>
            )}
          </p>
        )}

        {traits.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {traits.map((t) => (
              <span key={t} className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
                {traitLabel(t)}
              </span>
            ))}
          </div>
        )}
      </div>
    </article>
  )
}
