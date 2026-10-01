import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { displayAge } from '../services/discover'
import { loadOwnProfile, profileCompleteness, type OwnProfile } from '../services/profile'
import { cmToFeetInches } from '../types/profile'
import VisibilityControl from '../components/profile/VisibilityControl'
import TierBadge, { badgeTier, type BadgeTier } from '../components/TierBadge'
import {
  bodyTypeLabel,
  dealbreakerLabel,
  goDeeperRows,
  habitLabel,
  kidsDetail,
  lifestyleLabel,
  loveLanguageLabel,
  openToLabel,
  personalityLabel,
  profileGenderLabel,
  promptQuestion,
  relationshipStatusLabel,
  valueLabel,
  weekendLabel,
} from '../components/discover/labels'

function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-white/50">{children}</h3>
}

function Pills({ items, tone = 'neutral' }: { items: string[]; tone?: 'neutral' | 'cobalt' | 'red' }) {
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

function PhotoHero({ photos, name, glow }: { photos: string[]; name: string; glow: BadgeTier | null }) {
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
        <img src={photos[shown]} alt={`${name}, photo ${shown + 1}`} className="h-full w-full object-cover" />
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

function Completeness({ percent }: { percent: number }) {
  const hint =
    percent >= 90 ? '🎉 Fully complete!' : percent >= 50 ? 'Almost there!' : 'Keep going — more detail means better matches.'
  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="font-semibold text-white">Profile Completeness</h3>
        <span className="text-lg font-bold text-[#7C9BFF]">{percent}%</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-[#1B4FD8]" style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-2 text-sm text-white/50">{hint}</p>
    </section>
  )
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

type Loaded = { uid: string; data: OwnProfile | null }

// Your own Spark profile as matches see it, plus the owner-only extras:
// dealbreakers, completeness and visibility.
export default function Profile() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    loadOwnProfile(uid)
      .catch(() => null)
      .then((data) => {
        if (!cancelled) setLoaded({ uid, data })
      })
    return () => {
      cancelled = true
    }
  }, [uid])

  const page = 'min-h-[calc(100dvh-4rem)] bg-gray-950 text-white lg:min-h-[calc(100dvh-3.5rem)]'

  if (loaded?.uid !== uid) {
    return (
      <div className={`flex items-center justify-center ${page}`}>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      </div>
    )
  }
  if (!loaded.data) {
    return (
      <div className={`flex items-center justify-center px-4 ${page}`}>
        <p className="text-white/60">Couldn't load your profile.</p>
      </div>
    )
  }

  const own = loaded.data
  const p = own.profile
  const name = p.displayName ?? ''
  const age = displayAge(p)
  const gender = profileGenderLabel(p)
  const isFounder = (p as Record<string, unknown>).isFounder === true
  const tier = (p as Record<string, unknown>).zyloveScoreTier
  const bodyType = p.bodyType && p.bodyType !== 'prefer_not_to_say' ? bodyTypeLabel(p.bodyType) : null
  const weekend = list(p.weekendVibes).length > 0 ? list(p.weekendVibes) : list([p.weekendVibe])
  const kids = kidsDetail(p)
  const status =
    p.relationshipStatus && p.relationshipStatus !== 'prefer_not_to_say' ? relationshipStatusLabel(p.relationshipStatus) : null
  const deeper = goDeeperRows(p)
  const loveGive = list(p.loveLangGive).map(loveLanguageLabel)
  const loveReceive = list(p.loveLangReceive).map(loveLanguageLabel)

  return (
    <div className={page}>
      <div className="mx-auto max-w-xl space-y-8 px-4 pt-6 pb-8">
        <PhotoHero photos={list(p.photoURLs)} name={name} glow={badgeTier(tier)} />

        <header>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h1 className="text-3xl font-bold">
              {name || 'You'}
              {age !== null && <span className="font-normal text-white/70">, {age}</span>}
            </h1>
            {gender && <span className="text-white/60">· {gender}</span>}
            {p.pronouns && <span className="text-sm text-white/40">{p.pronouns}</span>}
          </div>
          {badgeTier(tier) && (
            <div className="mt-2 [&>span]:px-3 [&>span]:py-1 [&>span]:text-sm">
              <TierBadge tier={tier} />
            </div>
          )}
          {isFounder && (
            <span className="mt-2 inline-block rounded-full border border-[#1B4FD8]/40 bg-[#1B4FD8]/15 px-3 py-1 text-xs font-semibold text-[#B4C6FF]">
              ✦ Austin Founding Circle
            </span>
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-white/60">
            {p.locationLabel && <span>📍 {p.locationLabel}</span>}
            {typeof p.heightCm === 'number' && p.heightCm > 0 && <span>📏 {cmToFeetInches(p.heightCm)}</span>}
            {bodyType && <span>{bodyType}</span>}
          </div>
        </header>

        {own.bio && (
          <section>
            <SectionHeading>About</SectionHeading>
            <p className="whitespace-pre-line text-lg leading-relaxed text-white/80">{own.bio}</p>
          </section>
        )}

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

        {own.dealbreakers.length > 0 && (
          <section>
            <SectionHeading>What I'm looking for</SectionHeading>
            <Pills items={own.dealbreakers.map((d) => `🚫 ${dealbreakerLabel(d)}`)} tone="red" />
            <p className="mt-2 text-xs text-white/30">Only you can see this.</p>
          </section>
        )}

        {(loveGive.length > 0 || loveReceive.length > 0) && (
          <section>
            <SectionHeading>Love languages</SectionHeading>
            {loveGive.length > 0 && (
              <>
                <p className="mb-2 text-sm text-white/50">Gives 💝</p>
                <Pills items={loveGive} />
              </>
            )}
            {loveReceive.length > 0 && (
              <>
                <p className={`mb-2 text-sm text-white/50 ${loveGive.length > 0 ? 'mt-4' : ''}`}>Receives 💞</p>
                <Pills items={loveReceive} />
              </>
            )}
          </section>
        )}

        {own.prompts.length > 0 && (
          <section className="space-y-3">
            {own.prompts.map((q) => (
              <div key={q.promptId} className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <p className="text-sm text-white/40">{promptQuestion(q.promptId)}</p>
                <p className="mt-2 text-lg text-white">{q.answer}</p>
              </div>
            ))}
          </section>
        )}

        {deeper.length > 0 && (
          <section>
            <SectionHeading>How they operate</SectionHeading>
            <ul className="flex flex-col gap-y-2 text-sm">
              {deeper.map((r) => (
                <li key={r.label}>
                  <span className="text-white/40">{r.label}</span>
                  <span className="mx-2 text-white/20">·</span>
                  <span className="text-white">{r.value}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <Completeness percent={profileCompleteness(own)} />
        <VisibilityControl />
      </div>

      {/* Sits above the mobile bottom nav (h-16); flush on desktop. */}
      <div className="sticky bottom-16 border-t border-white/10 bg-gray-950 px-4 py-3 lg:bottom-0">
        <div className="mx-auto flex max-w-xl gap-3">
          <Link
            to="/profile/edit"
            className="flex-1 rounded-xl border border-[#1B4FD8] py-3 text-center font-semibold text-white transition-colors hover:bg-[#1B4FD8]/15"
          >
            ✏ Edit my profile
          </Link>
          <Link
            to="/zylove-score"
            className="flex-1 rounded-xl border border-white/20 py-3 text-center font-semibold text-white/80 transition-colors hover:bg-white/10"
          >
            🛡 Zylove Score
          </Link>
        </div>
      </div>
    </div>
  )
}
