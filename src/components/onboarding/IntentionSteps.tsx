import { useState } from 'react'
import type { DatingIntent } from '../../types/profile'
import type { OnboardingPath, StepProps } from './types'
import { StepHeader } from './ui'

export const INTENTION_OPTIONS = [
  { id: 'real_relationship', emoji: '💙', label: 'A real relationship', signal: 'spark' },
  { id: 'could_grow', emoji: '✨', label: 'Something that could grow', signal: 'spark' },
  { id: 'meaningful_connections', emoji: '😊', label: 'Meaningful connections', signal: 'spark' },
  { id: 'fun_no_pressure', emoji: '🔥', label: 'Fun without the pressure', signal: 'play' },
  { id: 'adventurous', emoji: '🌶️', label: 'Something more adventurous', signal: 'play' },
  { id: 'not_sure', emoji: '🤷', label: 'Not sure yet', signal: 'unsure' },
] as const

// Spark signals (and "not sure" alongside anything) lean Spark; Play signals
// with no Spark signal lean Play; both kinds → both; only "not sure" → unsure.
export function recommendPath(answers: string[]): OnboardingPath {
  const signals = new Set(INTENTION_OPTIONS.filter((o) => answers.includes(o.id)).map((o) => o.signal))
  const spark = signals.has('spark')
  const play = signals.has('play')
  if (spark && play) return 'both'
  if (play) return signals.has('unsure') ? 'both' : 'play'
  if (spark) return 'spark'
  return 'unsure'
}

// The intent Explore and scoring run on. Play-only people still have the
// basic profile, so they're 'open' and show in both feeds.
export function intentForPath(path: OnboardingPath): DatingIntent {
  return path === 'spark' || path === 'unsure' ? 'spark' : 'open'
}

export function IntentionStep({ draft, update }: StepProps) {
  function toggle(id: string) {
    const next = draft.intentionAnswers.includes(id)
      ? draft.intentionAnswers.filter((a) => a !== id)
      : [...draft.intentionAnswers, id]
    const path = next.length > 0 ? recommendPath(next) : null
    update({ intentionAnswers: next, onboardingPath: path, intent: path ? intentForPath(path) : null })
  }

  return (
    <div>
      <StepHeader
        title="What are you hoping to find?"
        subtitle="No wrong answers. This helps us point you in the right direction."
      />
      <div className="flex flex-wrap gap-2">
        {INTENTION_OPTIONS.map((o) => {
          const on = draft.intentionAnswers.includes(o.id)
          return (
            <button
              key={o.id}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(o.id)}
              className={`rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
                on ? 'border-[#1B4FD8] bg-[#1B4FD8] text-white' : 'border-white/15 bg-white/5 text-white/90 hover:border-white/40'
              }`}
            >
              <span aria-hidden>{o.emoji}</span> {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

const RECOMMENDATION: Record<
  OnboardingPath,
  { glow: string; title: string; body: string; button: string }
> = {
  spark: {
    glow: 'radial-gradient(circle at 50% 35%, rgba(27,79,216,0.55), transparent 65%)',
    title: '✦ Zylove Spark is built for you.',
    body: 'Real compatibility. Intentional connections. Something worth keeping.',
    button: 'Build my Spark profile →',
  },
  play: {
    glow: 'radial-gradient(circle at 50% 35%, rgba(224,49,49,0.55), transparent 65%)',
    title: '🔥 Play mode is calling.',
    body: 'Know what you want. Find who gets it.',
    button: 'Enter Play →',
  },
  both: {
    glow: 'linear-gradient(90deg, rgba(27,79,216,0.45), transparent 45%, transparent 55%, rgba(224,49,49,0.45))',
    title: '✦ Zylove has two sides.',
    body: 'Start with Spark. You can set up Play anytime from the mode pill.',
    button: '✦ Start with Spark →',
  },
  unsure: {
    glow: 'radial-gradient(circle at 50% 35%, rgba(27,79,216,0.4), transparent 65%)',
    title: '✦ No pressure. Start with Spark — it’s where most people begin.',
    body: 'You can always explore more later.',
    button: "Let's go →",
  },
}

// Full-screen, with the path's glow. Every screen has a way out if the
// recommendation is wrong: onChoose switches path and either moves on
// (advance) or stays to show that path's screen ("Show me both sides").
export function RecommendationScreen({
  path,
  onContinue,
  onChoose,
  onBack,
}: {
  path: OnboardingPath
  onContinue: () => void
  onChoose: (path: OnboardingPath, advance: boolean) => void
  onBack: () => void
}) {
  const r = RECOMMENDATION[path]
  const [differentOpen, setDifferentOpen] = useState(false)
  const choice = 'w-full rounded-xl border border-white/15 bg-white/5 py-3 text-sm font-medium text-white/80 hover:bg-white/10'
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-950 text-white">
      <div className="pointer-events-none absolute inset-0" style={{ background: r.glow }} aria-hidden />
      <div className="relative mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 text-center">
        <h1 className="text-3xl font-bold leading-tight">{r.title}</h1>
        {path === 'both' ? (
          <>
            <div className="mt-8 grid grid-cols-2 gap-3 text-left">
              <div className="rounded-2xl border border-[#1B4FD8]/50 bg-[#1B4FD8]/15 p-4">
                <p className="font-semibold text-[#9DB4FF]">Spark</p>
                <p className="mt-1 text-sm text-white/70">for real connections</p>
              </div>
              <div className="rounded-2xl border border-[#E03131]/50 bg-[#E03131]/15 p-4">
                <p className="font-semibold text-red-300">Play</p>
                <p className="mt-1 text-sm text-white/70">for when you want something different</p>
              </div>
            </div>
            <p className="mt-6 text-white/70">{r.body}</p>
          </>
        ) : (
          <p className="mt-4 text-lg text-white/70">{r.body}</p>
        )}
        {path === 'play' && (
          <>
            <div className="mx-auto mt-6 h-px w-16 bg-white/15" aria-hidden />
            <p className="mb-2 mt-4 text-center text-sm text-white/50">
              🔒 Play is completely separate. What happens in Play, stays in Play.
            </p>
          </>
        )}
      </div>
      <div className="relative mx-auto w-full max-w-md px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]">
        <button
          type="button"
          onClick={onContinue}
          autoFocus
          className={`w-full rounded-xl py-4 font-semibold text-white transition-opacity hover:opacity-90 ${
            path === 'play' ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'
          }`}
        >
          {r.button}
        </button>
        {path === 'both' && (
          <>
            <button
              type="button"
              onClick={() => onChoose('play', true)}
              className="mt-3 w-full rounded-xl bg-[#E03131] py-4 font-semibold text-white transition-opacity hover:opacity-90"
            >
              🔥 Start with Play →
            </button>
            <p className="mt-2 text-center text-xs text-white/30">
              <button type="button" onClick={() => onChoose('spark', true)} className="hover:text-white">
                Just Spark for now
              </button>
              <span className="mx-2" aria-hidden>
                ·
              </span>
              <button type="button" onClick={() => onChoose('play', true)} className="hover:text-white">
                Just Play for now
              </button>
            </p>
          </>
        )}
        {(path === 'spark' || path === 'play') &&
          (differentOpen ? (
            <div className="mt-3 space-y-2">
              {path === 'spark' ? (
                <button type="button" onClick={() => onChoose('play', true)} className={choice}>
                  🔥 Take me to Play
                </button>
              ) : (
                <button type="button" onClick={() => onChoose('spark', true)} className={choice}>
                  💙 Take me to Spark
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setDifferentOpen(false)
                  onChoose('both', false)
                }}
                className={choice}
              >
                ✨ Show me both sides
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setDifferentOpen(true)}
              className="mt-3 w-full text-center text-sm text-white/40 hover:text-white"
            >
              Actually, I'm looking for something different →
            </button>
          ))}
        <button type="button" onClick={onBack} className="mt-2 w-full py-2 text-sm text-white/40 hover:text-white">
          Back
        </button>
      </div>
    </div>
  )
}
