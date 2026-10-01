import type { ReactNode } from 'react'
import type { DiscoverProfile } from '../../services/discover'
import type { PlayProfileData } from '../../services/profile'
import {
  PLAY_NON_NEGOTIABLE_LABELS,
  PLAY_TAG_CATEGORY_LABELS,
  PLAY_TAG_LABELS,
  SPICE_META,
  type PlayInterestTag,
  type PlayNonNegotiable,
  type SpiceLevel,
} from '../../types/dualProfile'
import { promptQuestion } from '../discover/labels'
import { PhotoHero, Pills, ProfileHeader, SectionHeading } from './ProfileSections'
import { badgeTier } from '../TierBadge'

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

function has<K extends string>(record: Record<K, unknown>, key: string): key is K {
  return Object.prototype.hasOwnProperty.call(record, key)
}

// Interests grouped by category, e.g. "⚡ Dynamic": [...].
function groupedInterests(tags: string[]): { title: string; items: string[] }[] {
  const groups = new Map<string, string[]>()
  for (const tag of tags) {
    const meta = has(PLAY_TAG_LABELS, tag) ? PLAY_TAG_LABELS[tag as PlayInterestTag] : null
    const category = meta?.category ?? 'other'
    const label = meta ? `${meta.emoji} ${meta.label}` : tag.replace(/_/g, ' ')
    groups.set(category, [...(groups.get(category) ?? []), label])
  }
  return [...groups].map(([category, items]) => {
    const c = PLAY_TAG_CATEGORY_LABELS[category]
    return { title: c ? `${c.emoji} ${c.label}` : 'Into', items }
  })
}

// The Play face of a profile: Play photos, bio, spice level, interests,
// non-negotiables and Play prompts. Identity basics come from the root doc.
export default function PlayProfileSections({
  profile,
  play,
  afterHeader,
}: {
  profile: DiscoverProfile
  play: PlayProfileData
  afterHeader?: ReactNode
}) {
  const photos = play.photoURLs.length > 0 ? play.photoURLs : list(profile.photoURLs)
  const bio = play.playBio || profile.bio?.trim() || ''
  const spice = play.spiceLevel && has(SPICE_META, play.spiceLevel) ? SPICE_META[play.spiceLevel as SpiceLevel] : null
  const nonNegotiables = play.playNonNegotiables.map((k) =>
    has(PLAY_NON_NEGOTIABLE_LABELS, k) ? PLAY_NON_NEGOTIABLE_LABELS[k as PlayNonNegotiable] : k.replace(/_/g, ' '),
  )
  const prompts = play.promptAnswers

  return (
    <>
      <PhotoHero
        photos={photos}
        name={profile.displayName ?? ''}
        glow={badgeTier((profile as Record<string, unknown>).zyloveScoreTier)}
      />
      <ProfileHeader profile={profile} nameFallback="Someone" />

      {afterHeader}

      {bio && (
        <section>
          <SectionHeading>About</SectionHeading>
          <p className="whitespace-pre-line text-lg leading-relaxed text-white/80">{bio}</p>
        </section>
      )}

      {spice && (
        <section
          className="flex items-center gap-4 rounded-2xl border p-4"
          style={{ borderColor: `${spice.color}66`, backgroundColor: `${spice.color}1a` }}
        >
          <span className="text-3xl" aria-hidden>
            {spice.emoji}
          </span>
          <span>
            <span className="block font-semibold" style={{ color: spice.color }}>
              {spice.label}
            </span>
            <span className="block text-sm text-white/60">{spice.description}</span>
          </span>
        </section>
      )}

      {groupedInterests(play.playInterestTags).map((g) => (
        <section key={g.title}>
          <SectionHeading>{g.title}</SectionHeading>
          <Pills items={g.items} />
        </section>
      ))}

      {nonNegotiables.length > 0 && (
        <section>
          <SectionHeading>Non-negotiables</SectionHeading>
          <Pills items={nonNegotiables.map((n) => `🔒 ${n}`)} tone="red" />
        </section>
      )}

      {prompts.length > 0 && (
        <section className="space-y-3">
          {prompts.map((q) => (
            <div key={q.promptId} className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <p className="text-sm text-white/40">{promptQuestion(q.promptId)}</p>
              <p className="mt-2 text-lg text-white">{q.answer}</p>
            </div>
          ))}
        </section>
      )}
    </>
  )
}
