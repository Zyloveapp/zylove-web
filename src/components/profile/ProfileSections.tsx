import { useState, type ReactNode } from 'react'
import { displayAge, type DiscoverProfile } from '../../services/discover'
import type { PromptAnswer } from '../../types/dualProfile'
import { cmToFeetInches } from '../../types/profile'
import HowIOperate from './HowIOperate'
import { goDeeperAnswers } from './goDeeper'
import TierBadge, { badgeTier, type BadgeTier } from '../TierBadge'
import FounderBadge from '../FounderBadge'
import DistanceLabel from '../DistanceLabel'
import { useAuthStore } from '../../store/authStore'
import {
  bodyTypeLabel,
  habitLabel,
  kidsDetail,
  lifestyleLabel,
  loveLanguageLabel,
  personalityLabel,
  identityLine,
  openToLabel,
  promptQuestion,
  relationshipStatusLabel,
  valueLabel,
  weekendLabel,
} from '../discover/labels'
import StoredImg from '../StoredImg'

export function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-white/50">{children}</h3>
}

export function Pills({ items, tone = 'neutral' }: { items: string[]; tone?: 'neutral' | 'cobalt' | 'red' }) {
  const color =
    tone === 'cobalt'
      ? 'border-[#1B4FD8]/40 bg-[#1B4FD8]/15 text-[#B4C6FF]'
      : tone === 'red'
        ? 'border-red-500/30 bg-red-500/10 text-red-200'
        : 'border-white/10 bg-white/[0.08] text-white/70'
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <span key={item} className={`rounded-full border px-3.5 py-1.5 text-sm ${color}`}>
          {item}
        </span>
      ))}
    </div>
  )
}

function TagSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <section>
      <SectionHeading>{title}</SectionHeading>
      <Pills items={items} />
    </section>
  )
}

// Earned-badge glow around the photo.
const GLOW: Record<BadgeTier, string> = {
  trusted: 'ring-2 ring-[#1B4FD8]/60 ring-offset-2 ring-offset-gray-950',
  elite: 'ring-2 ring-amber-400/60 ring-offset-2 ring-offset-gray-950',
}

export function PhotoHero({ photos, name, glow }: { photos: string[]; name: string; glow: BadgeTier | null }) {
  const ring = glow ? GLOW[glow] : ''
  const [index, setIndex] = useState(0)
  const count = photos.length
  if (count === 0) {
    return (
      <div className={`flex aspect-[3/4] w-full items-center justify-center rounded-2xl bg-[#1B4FD8]/20 ${ring}`}>
        <span className="text-7xl font-bold text-[#7C9BFF]">{name.charAt(0).toUpperCase() || '?'}</span>
      </div>
    )
  }
  const shown = Math.min(index, count - 1)
  return (
    <div>
      <div className={`relative aspect-[3/4] w-full overflow-hidden rounded-2xl bg-white/5 ${ring}`}>
        <StoredImg src={photos[shown]} alt={`${name}, photo ${shown + 1}`} className="h-full w-full object-cover" />
        {count > 1 && (
          <>
            <button
              type="button"
              onClick={() => setIndex((shown - 1 + count) % count)}
              aria-label="Previous photo"
              className="absolute inset-y-0 left-0 w-1/2"
            />
            <button
              type="button"
              onClick={() => setIndex((shown + 1) % count)}
              aria-label="Next photo"
              className="absolute inset-y-0 right-0 w-1/2"
            />
          </>
        )}
      </div>
      {count > 1 && (
        <div className="mt-3 flex justify-center gap-2">
          {photos.map((url, i) => (
            <button
              key={url}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`Photo ${i + 1}`}
              aria-current={i === shown}
              className={`h-2 w-2 rounded-full border border-white/60 ${i === shown ? 'bg-white' : 'bg-transparent'}`}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// Name, age, gender, pronouns, badges and basics — shared by the Spark and
// Play profile layouts.
export function ProfileHeader({ profile: p, nameFallback }: { profile: DiscoverProfile; nameFallback: string }) {
  const name = p.displayName ?? ''
  const age = displayAge(p)
  const identity = identityLine(p)
  const isFounder = (p as Record<string, unknown>).isFounder === true
  const tier = (p as Record<string, unknown>).zyloveScoreTier
  const bodyType = p.bodyType && p.bodyType !== 'prefer_not_to_say' ? bodyTypeLabel(p.bodyType) : null
  return (
    <header>
      <h1 className="text-3xl font-bold">
        {name || nameFallback}
        {age !== null && <span className="font-normal text-white/70">, {age}</span>}
      </h1>
      {identity && <p className="mt-1 text-sm text-white/50">{identity}</p>}
      {badgeTier(tier) && (
        <div className="mt-2 [&>span]:px-3 [&>span]:py-1 [&>span]:text-sm">
          <TierBadge tier={tier} />
        </div>
      )}
      {isFounder && (
        <div className="mt-2">
          <FounderBadge profile={p} />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-white/60">
        <DistanceLabel profile={p} />
        {typeof p.heightCm === 'number' && p.heightCm > 0 && <span>📏 {cmToFeetInches(p.heightCm)}</span>}
        {bodyType && <span>{bodyType}</span>}
      </div>
    </header>
  )
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

interface ProfileSectionsProps {
  profile: DiscoverProfile
  bio: string
  prompts: PromptAnswer[]
  dynamicPrompt: string | null
  // Shown when the profile has no name (own profile: "You").
  nameFallback: string
  // Under the name block (viewing someone else: the compatibility report).
  afterHeader?: ReactNode
  // Owner-only slots: "What I'm looking for" and the "Just for you" card.
  lookingFor?: ReactNode
  promptsExtra?: ReactNode
}

// The public face of a Spark profile — photos through prompts — shared by
// your own Profile page and /profile/:uid.
export default function ProfileSections({
  profile: p,
  bio,
  prompts,
  dynamicPrompt,
  nameFallback,
  afterHeader,
  lookingFor,
  promptsExtra,
}: ProfileSectionsProps) {
  const tier = (p as Record<string, unknown>).zyloveScoreTier
  const weekend = list(p.weekendVibes).length > 0 ? list(p.weekendVibes) : list([p.weekendVibe])
  const kids = kidsDetail(p)
  const status =
    p.relationshipStatus && p.relationshipStatus !== 'prefer_not_to_say' ? relationshipStatusLabel(p.relationshipStatus) : null
  const loveGive = list(p.loveLangGive).map(loveLanguageLabel)
  const loveReceive = list(p.loveLangReceive).map(loveLanguageLabel)
  // The Go Deeper prompt is for the owner; others just see the answers.
  const own = useAuthStore((s) => s.user?.uid) === p.uid

  return (
    <>
      <PhotoHero photos={list(p.photoURLs)} name={p.displayName ?? ''} glow={badgeTier(tier)} />

      <ProfileHeader profile={p} nameFallback={nameFallback} />

      {afterHeader}

      {bio && (
        <section>
          <SectionHeading>About</SectionHeading>
          <p className="whitespace-pre-line text-lg leading-relaxed text-white/80">{bio}</p>
        </section>
      )}

      <HowIOperate answers={goDeeperAnswers(p)} own={own} />

      {list(p.openTo).length > 0 && <Pills items={list(p.openTo).map(openToLabel)} tone="cobalt" />}

      <TagSection title="Personality" items={list(p.personalityTraits).map(personalityLabel)} />
      <TagSection title="Lifestyle" items={list(p.lifestyleTags).map(lifestyleLabel)} />
      <TagSection title="Habits" items={list(p.habitTags).map(habitLabel)} />
      <TagSection title="Weekend energy" items={weekend.map(weekendLabel)} />
      <TagSection title="What I value" items={list(p.relationshipValues).map(valueLabel)} />

      {(kids || status) && (
        <section>
          <SectionHeading>Life details</SectionHeading>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-4">
            {kids && (
              <div>
                <dt className="text-xs text-white/40">Kids</dt>
                <dd className="mt-1 text-sm text-white">{kids}</dd>
              </div>
            )}
            {status && (
              <div>
                <dt className="text-xs text-white/40">Relationship status</dt>
                <dd className="mt-1 text-sm text-white">{status}</dd>
              </div>
            )}
          </dl>
        </section>
      )}

      {lookingFor}

      {loveGive.length > 0 && (
        <section>
          <SectionHeading>How I show love</SectionHeading>
          <Pills items={loveGive} />
        </section>
      )}

      {loveReceive.length > 0 && (
        <section>
          <SectionHeading>How I feel loved</SectionHeading>
          <Pills items={loveReceive} />
        </section>
      )}

      {(prompts.length > 0 || promptsExtra) && (
        <section className="space-y-3">
          {prompts.map((q) => (
            <div key={q.promptId} className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <p className="text-sm text-white/40">{promptQuestion(q.promptId, dynamicPrompt)}</p>
              <p className="mt-2 text-lg text-white">{q.answer}</p>
            </div>
          ))}
          {promptsExtra}
        </section>
      )}
    </>
  )
}
