import type { ReactNode } from 'react'
import type { DiscoverProfile } from '../../services/discover'
import type { PlayProfileData } from '../../services/playProfile'
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
import { typePreferenceLabels } from '../../types/playDescriptors'
import { playNameOf } from '../../services/displayNames'
import { PhotoHero, Pills, ProfileHeader, SectionHeading } from './ProfileSections'
import { badgeTier } from '../TierBadge'

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
// Bio, spice level, grouped interests, non-negotiables and Play prompts —
// the Play body shared by the Play profile pages and Play Explore.
export function PlayDetailsBody({ bio, play }: { bio: string; play: PlayProfileData }) {
  const spice = play.spiceLevel && has(SPICE_META, play.spiceLevel) ? SPICE_META[play.spiceLevel as SpiceLevel] : null
  const nonNegotiables = play.playNonNegotiables.map((k) =>
    has(PLAY_NON_NEGOTIABLE_LABELS, k) ? PLAY_NON_NEGOTIABLE_LABELS[k as PlayNonNegotiable] : k.replace(/_/g, ' '),
  )
  const prompts = play.promptAnswers
  // Hidden when every category is "Doesn't matter" or unanswered.
  const myType = typePreferenceLabels(play.typePreferences)

  return (
    <>
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

      {play.descriptors.length > 0 && (
        <section>
          <SectionHeading>About me</SectionHeading>
          <Pills items={play.descriptors} />
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

      {myType.length > 0 && (
        <section>
          <SectionHeading>My type</SectionHeading>
          <Pills items={myType} tone="red" />
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

      {play.goDeeper.length > 0 && (
        <section className="space-y-3">
          <SectionHeading>Go Deeper 🔥</SectionHeading>
          {play.goDeeper.map((g) => (
            <div key={g.question} className="rounded-2xl border border-[#E03131]/25 bg-[#E03131]/5 p-5">
              <p className="text-sm text-white/40">{g.question}</p>
              <p className="mt-2 text-lg text-white">{g.answer}</p>
            </div>
          ))}
        </section>
      )}
    </>
  )
}

export default function PlayProfileSections({
  profile,
  play,
  afterHeader,
}: {
  profile: DiscoverProfile
  play: PlayProfileData
  afterHeader?: ReactNode
}) {
  // Play shows only Play data — name, photos, bio — never the Spark ones;
  // the header reads the name through displayName. Spark height and body
  // type stay off it: Play's own show under "A little about me".
  const named = { ...profile, displayName: playNameOf(profile, play) || 'Someone', heightCm: undefined, bodyType: undefined }
  const photos = play.photoURLs
  const bio = play.playBio

  return (
    <>
      <PhotoHero
        photos={photos}
        name={named.displayName ?? ''}
        glow={badgeTier((profile as Record<string, unknown>).zyloveScoreTier)}
      />
      <ProfileHeader profile={named} nameFallback="Someone" />
      {afterHeader}
      <PlayDetailsBody bio={bio} play={play} />
    </>
  )
}
