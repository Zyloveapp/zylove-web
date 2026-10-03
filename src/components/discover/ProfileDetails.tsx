import type { ReactNode } from 'react'
import { displayAge, type DiscoverProfile } from '../../services/discover'
import type { Mode } from '../../store/modeStore'
import CompatibilityBlock from './CompatibilityBlock'
import TierBadge from '../TierBadge'
import FounderBadge from '../FounderBadge'
import { PlayDetailsBody } from '../profile/PlayProfileSections'
import {
  goDeeperRows,
  identityLine,
  lifeDetails,
  lifestyleLabel,
  loveLanguageLabel,
  openToLabel,
  personalityLabel,
  promptQuestion,
  valueLabel,
} from './labels'

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-[11px] uppercase tracking-widest text-white font-semibold mb-4">
      {children}
    </h3>
  )
}

function Pills({ items, icon }: { items: string[]; icon?: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <span key={item} className="rounded-full border border-white/10 bg-white/[0.08] px-4 py-1.5 text-sm text-white/70">
          {icon && <span className="mr-1.5 opacity-70">{icon}</span>}
          {item}
        </span>
      ))}
    </div>
  )
}

// Locations are snapped to ~3 miles, so distances are approximate.
function distanceLabel(miles: number): string {
  return miles < 5 ? 'Nearby' : `~${Math.round(miles)} mi away`
}

export default function ProfileDetails({
  profile,
  mode,
  autoRevealScore = false,
  match,
}: {
  profile: DiscoverProfile
  mode: Mode
  autoRevealScore?: boolean
  // Viewing a linked profile: the report ends with a "Break the ice" opener.
  match?: { matchId: string }
}) {
  const age = displayAge(profile)
  // Set only by Play Explore, which loads each candidate's playProfile/data.
  const play = mode === 'play' ? (profile.playProfile ?? null) : null
  const bio = profile.bio?.trim()
  const prompts = (profile.promptAnswers ?? []).filter((p) => p.answer?.trim())
  const deeper = goDeeperRows(profile)
  const traits = (profile.personalityTraits ?? []).map(personalityLabel)
  const values = (profile.relationshipValues ?? []).map(valueLabel)
  const lifestyle = (profile.lifestyleTags ?? []).map(lifestyleLabel)
  const loveGive = (profile.loveLangGive ?? []).map(loveLanguageLabel)
  const loveReceive = (profile.loveLangReceive ?? []).map(loveLanguageLabel)
  const details = lifeDetails(profile)
  const identity = identityLine(profile)
  const openTo = (profile.openTo ?? []).map(openToLabel)

  return (
    <div className="space-y-8">
      <header className="border-b border-white/10 pb-6">
        <h2 className="text-4xl font-bold">
          {profile.displayName ?? 'Someone'}
          {age !== null && <span className="font-normal text-white/70">, {age}</span>}
        </h2>
        {identity && <p className="mt-1 text-sm text-white/50">{identity}</p>}
        <div className="mt-2 flex flex-wrap gap-2 empty:hidden">
          <FounderBadge profile={profile} />
          <TierBadge tier={(profile as Record<string, unknown>).zyloveScoreTier} />
        </div>
        {(profile.locationLabel || profile.distanceMiles !== undefined) && (
          <p className="mt-1 text-sm text-white/40">
            {[profile.locationLabel, profile.distanceMiles !== undefined && distanceLabel(profile.distanceMiles)]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
        <CompatibilityBlock
          key={profile.uid}
          profile={profile}
          mode={mode}
          autoReveal={autoRevealScore}
          fullReport={autoRevealScore}
          match={match}
        />
      </header>

      {/* Play Explore: the Play profile only (bio, spice, interests,
          non-negotiables, Play prompts) — no Spark sections. */}
      {play ? (
        <PlayDetailsBody bio={play.playBio || profile.bio?.trim() || ''} play={play} />
      ) : (
        <>

          {bio && (
            <section>
              <SectionHeading>About</SectionHeading>
              <p className="whitespace-pre-line text-lg leading-relaxed text-white/80">{bio}</p>
            </section>
          )}

          {prompts.length > 0 && (
            <section>
              <SectionHeading>In their own words</SectionHeading>
              <div className="space-y-5">
                {prompts.map((p) => (
                  <div key={p.promptId} className="border-l-2 border-white/10 pl-4">
                    <p className="text-sm text-white/30">{promptQuestion(p.promptId, (profile as Record<string, unknown>).dynamicPrompt)}</p>
                    <p className="mt-1 text-base text-white">{p.answer}</p>
                  </div>
                ))}
              </div>
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

          {openTo.length > 0 && (
            <section>
              <SectionHeading>Open to</SectionHeading>
              <Pills items={openTo} />
            </section>
          )}

          {traits.length > 0 && (
            <section>
              <SectionHeading>Personality</SectionHeading>
              <Pills items={traits} />
            </section>
          )}

          {(values.length > 0 || lifestyle.length > 0) && (
            <section className="grid gap-8 md:grid-cols-2">
              {values.length > 0 && (
                <div>
                  <SectionHeading>Values</SectionHeading>
                  <Pills items={values} />
                </div>
              )}
              {lifestyle.length > 0 && (
                <div>
                  <SectionHeading>Lifestyle</SectionHeading>
                  <Pills items={lifestyle} />
                </div>
              )}
            </section>
          )}

          {(loveGive.length > 0 || loveReceive.length > 0) && (
            <section className="grid gap-8 md:grid-cols-2">
              {loveGive.length > 0 && (
                <div>
                  <SectionHeading>Shows love by</SectionHeading>
                  <Pills items={loveGive} icon="♥" />
                </div>
              )}
              {loveReceive.length > 0 && (
                <div>
                  <SectionHeading>Feels loved when</SectionHeading>
                  <Pills items={loveReceive} icon="♥" />
                </div>
              )}
            </section>
          )}

          {details.length > 0 && (
            <section>
              <SectionHeading>Life details</SectionHeading>
              <dl className="grid grid-cols-2 gap-x-8 gap-y-5">
                {details.map((d) => (
                  <div key={d.label}>
                    <dt className="text-xs text-white/30">{d.label}</dt>
                    <dd className="mt-1 text-sm text-white">{d.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </>
      )}
    </div>
  )
}
