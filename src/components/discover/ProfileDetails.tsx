import type { ReactNode } from 'react'
import { displayAge, type DiscoverProfile } from '../../services/discover'
import type { Mode } from '../../store/modeStore'
import CompatibilityBlock from './CompatibilityBlock'
import { discoverTheme } from './theme'
import {
  goDeeperRows,
  lifeDetails,
  lifestyleLabel,
  loveLanguageLabel,
  personalityLabel,
  promptQuestion,
  valueLabel,
} from './labels'

function SectionHeading({ children, className }: { children: ReactNode; className: string }) {
  return (
    <h3 className={`mb-4 border-b border-white/5 pb-2 text-[10px] uppercase tracking-[0.2em] ${className}`}>
      {children}
    </h3>
  )
}

function Pills({ items, icon, className }: { items: string[]; icon?: string; className: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <span key={item} className={`rounded-full px-4 py-2 text-sm ${className}`}>
          {icon && <span className="mr-1.5 opacity-70">{icon}</span>}
          {item}
        </span>
      ))}
    </div>
  )
}

export default function ProfileDetails({ profile, mode }: { profile: DiscoverProfile; mode: Mode }) {
  const age = displayAge(profile)
  const bio = profile.bio?.trim()
  const prompts = (profile.promptAnswers ?? []).filter((p) => p.answer?.trim())
  const deeper = goDeeperRows(profile)
  const traits = (profile.personalityTraits ?? []).map(personalityLabel)
  const values = (profile.relationshipValues ?? []).map(valueLabel)
  const lifestyle = (profile.lifestyleTags ?? []).map(lifestyleLabel)
  const loveGive = (profile.loveLangGive ?? []).map(loveLanguageLabel)
  const loveReceive = (profile.loveLangReceive ?? []).map(loveLanguageLabel)
  const details = lifeDetails(profile)
  const promptBorder = mode === 'play' ? 'border-white/10' : 'border-[#1B4FD8]/40'
  const theme = discoverTheme(mode)

  return (
    <div className="space-y-8">
      <header className="border-b border-white/10 pb-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-4xl font-bold">
            {profile.displayName ?? 'Someone'}
            {age !== null && <span className="font-normal text-white/70">, {age}</span>}
          </h2>
          <span className="rounded-full bg-white/10 px-3 py-1 text-sm">
            {mode === 'play' ? '🔴 Play' : '🔵 Spark'}
          </span>
        </div>
        {profile.locationLabel && <p className="mt-1 text-sm text-white/40">{profile.locationLabel}</p>}
        <CompatibilityBlock key={profile.uid} targetUid={profile.uid} mode={mode} />
      </header>

      {bio && (
        <section>
          <SectionHeading className={theme.heading}>About</SectionHeading>
          <p className="whitespace-pre-line text-lg leading-relaxed text-white/80">{bio}</p>
        </section>
      )}

      {prompts.length > 0 && (
        <section>
          <SectionHeading className={theme.heading}>In their own words</SectionHeading>
          <div className="space-y-5">
            {prompts.map((p) => (
              <div key={p.promptId} className={`border-l-2 pl-4 ${promptBorder}`}>
                <p className="text-sm text-white/30">{promptQuestion(p.promptId)}</p>
                <p className="mt-1 text-base text-white">{p.answer}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {deeper.length > 0 && (
        <section>
          <SectionHeading className={theme.heading}>How they operate</SectionHeading>
          <ul className="flex flex-col gap-y-2 text-sm">
            {deeper.map((r) => (
              <li key={r.label}>
                <span className={theme.operateLabel}>{r.label}</span>
                <span className={`mx-2 ${theme.operateLabel}`}>·</span>
                <span className="text-white">{r.value}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {traits.length > 0 && (
        <section>
          <SectionHeading className={theme.heading}>Personality</SectionHeading>
          <Pills items={traits} className={theme.pill} />
        </section>
      )}

      {(values.length > 0 || lifestyle.length > 0) && (
        <section className="grid gap-8 md:grid-cols-2">
          {values.length > 0 && (
            <div>
              <SectionHeading className={theme.heading}>Values</SectionHeading>
              <Pills items={values} className={theme.pill} />
            </div>
          )}
          {lifestyle.length > 0 && (
            <div>
              <SectionHeading className={theme.heading}>Lifestyle</SectionHeading>
              <Pills items={lifestyle} className={theme.pill} />
            </div>
          )}
        </section>
      )}

      {(loveGive.length > 0 || loveReceive.length > 0) && (
        <section className="grid gap-8 md:grid-cols-2">
          {loveGive.length > 0 && (
            <div>
              <SectionHeading className={theme.heading}>Shows love by</SectionHeading>
              <Pills items={loveGive} icon="♥" className={theme.pill} />
            </div>
          )}
          {loveReceive.length > 0 && (
            <div>
              <SectionHeading className={theme.heading}>Feels loved when</SectionHeading>
              <Pills items={loveReceive} icon="♥" className={theme.pill} />
            </div>
          )}
        </section>
      )}

      {details.length > 0 && (
        <section>
          <SectionHeading className={theme.heading}>Life details</SectionHeading>
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
    </div>
  )
}
