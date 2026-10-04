import { useEffect, useState, type ReactNode } from 'react'
import {
  PLAY_NON_NEGOTIABLE_LABELS,
  PLAY_PROMPT_BANK,
  PLAY_TAG_LABELS,
  SPICE_META,
  type PlayInterestTag,
  type PlayNonNegotiable,
  type SpiceLevel,
} from '../../types/dualProfile'
import { tagsIn, type PlayDraft, type PlayTagCategory } from '../../services/playOnboarding'

// The Play steps of the Play-only path in /onboarding. Same steps and copy as
// PlayOnboarding.tsx (which still serves mode-pill setup and Play edits).

export const PLAY_BIO_MAX = 300
const ANSWER_MAX = 200

interface PlayStepProps {
  play: PlayDraft
  update: (patch: Partial<PlayDraft>) => void
}

const SCENE_SECTIONS: { category: PlayTagCategory; title: string }[] = [
  { category: 'acts', title: "What I'm into" },
  { category: 'dynamic', title: 'My dynamic' },
  { category: 'vibe', title: 'My vibe' },
  { category: 'place', title: 'Where I play' },
]

function tagsOfCategory(category: PlayTagCategory): PlayInterestTag[] {
  return (Object.keys(PLAY_TAG_LABELS) as PlayInterestTag[]).filter((t) => PLAY_TAG_LABELS[t].category === category)
}

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
}

function promptText(id: string): string {
  return PLAY_PROMPT_BANK.find((p) => p.id === id)?.text ?? id
}

function Pill({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded-full border px-3.5 py-2 text-sm transition-colors ${
        selected
          ? 'border-[#E03131]/40 bg-[#E03131]/20 text-red-400'
          : 'border-white/10 bg-white/5 text-white/70 hover:border-white/25'
      }`}
    >
      {children}
    </button>
  )
}

function Heading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold text-white">{title}</h1>
      {subtitle && <p className="mt-1 text-white/50">{subtitle}</p>}
    </div>
  )
}

export function PlayWelcomeStep() {
  return (
    <div className="flex min-h-[60dvh] flex-col justify-center text-center">
      <h1 className="text-5xl font-bold text-white">🔴 Play</h1>
      <p className="mt-4 text-xl text-white/80">Same you. Different energy. Entirely yours.</p>
      <p className="mt-4 text-white/50">
        Your Spark profile stays completely separate. What happens in Play, stays in Play.
      </p>
    </div>
  )
}

export function SpiceStep({ play, update }: PlayStepProps) {
  return (
    <>
      <Heading title="Your spice level" subtitle="Be honest. It helps everyone." />
      <div className="space-y-3">
        {(Object.keys(SPICE_META) as SpiceLevel[]).map((level) => {
          const meta = SPICE_META[level]
          const selected = play.spiceLevel === level
          return (
            <button
              key={level}
              type="button"
              onClick={() => update({ spiceLevel: level })}
              aria-pressed={selected}
              className={`flex w-full items-center gap-4 rounded-2xl border p-4 text-left transition-colors ${
                selected ? 'border-[#E03131]/60 bg-[#E03131]/15' : 'border-white/10 bg-white/5 hover:border-white/25'
              }`}
            >
              <span className="text-3xl" aria-hidden>
                {meta.emoji}
              </span>
              <span className="flex-1">
                <span className={`block font-semibold ${selected ? 'text-red-400' : 'text-white'}`}>{meta.label}</span>
                <span className="mt-0.5 block text-sm text-white/50">{meta.description}</span>
              </span>
              {selected && <span className="text-lg font-bold text-red-400">✓</span>}
            </button>
          )
        })}
      </div>
    </>
  )
}

export function ArrangementStep({ play, update }: PlayStepProps) {
  return (
    <>
      <Heading title="What are you looking for?" subtitle="Pick at least one." />
      <div className="flex flex-wrap gap-2">
        {tagsOfCategory('arrangement').map((t) => (
          <Pill key={t} selected={play.tags.includes(t)} onClick={() => update({ tags: toggle(play.tags, t) })}>
            {PLAY_TAG_LABELS[t].emoji} {PLAY_TAG_LABELS[t].label}
          </Pill>
        ))}
      </div>
    </>
  )
}

export function SceneStep({ play, update }: PlayStepProps) {
  const [openSections, setOpenSections] = useState<PlayTagCategory[]>(['acts'])
  return (
    <>
      <Heading title="What's your scene?" subtitle="All optional — open any section that fits." />
      <div className="space-y-3">
        {SCENE_SECTIONS.map(({ category, title }) => {
          const open = openSections.includes(category)
          const count = tagsIn(play.tags, category).length
          return (
            <section key={category} className="rounded-2xl border border-white/10 bg-white/[0.03]">
              <button
                type="button"
                onClick={() => setOpenSections((s) => toggle(s, category))}
                aria-expanded={open}
                className="flex w-full items-center justify-between px-4 py-3 text-left"
              >
                <span className="text-sm font-semibold uppercase tracking-widest text-[#E03131]/80">{title}</span>
                <span className="text-sm text-white/40">
                  {count > 0 && `${count} selected · `}
                  {open ? '−' : '+'}
                </span>
              </button>
              {open && (
                <div className="flex flex-wrap gap-2 px-4 pb-4">
                  {tagsOfCategory(category).map((t) => (
                    <Pill
                      key={t}
                      selected={play.tags.includes(t)}
                      onClick={() => update({ tags: toggle(play.tags, t) })}
                    >
                      {PLAY_TAG_LABELS[t].emoji} {PLAY_TAG_LABELS[t].label}
                    </Pill>
                  ))}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </>
  )
}

export function NonNegotiablesStep({ play, update }: PlayStepProps) {
  return (
    <>
      <Heading
        title="My non-negotiables"
        subtitle="What you always need. Others see this — it filters who reaches out."
      />
      <div className="flex flex-wrap gap-2">
        {(Object.keys(PLAY_NON_NEGOTIABLE_LABELS) as PlayNonNegotiable[]).map((k) => (
          <Pill
            key={k}
            selected={play.nonNegotiables.includes(k)}
            onClick={() => update({ nonNegotiables: toggle(play.nonNegotiables, k) })}
          >
            {PLAY_NON_NEGOTIABLE_LABELS[k]}
          </Pill>
        ))}
      </div>
    </>
  )
}

// "↻ Different question": the whole Play prompt bank in a dark red sheet.
// ✓ marks prompts you've written an answer for.
function PlayPromptPicker({
  current,
  answers,
  onPick,
  onClose,
}: {
  current: string
  answers: Record<string, string>
  onPick: (id: string) => void
  onClose: () => void
}) {
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="play-prompt-picker-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex max-h-[80dvh] w-full flex-col rounded-t-2xl border border-[#E03131]/30 bg-[#140707] text-white lg:max-w-md lg:rounded-2xl">
        <div className="flex items-center justify-between border-b border-[#E03131]/20 px-6 py-4">
          <h2 id="play-prompt-picker-title" className="font-semibold">
            Choose a question
          </h2>
          <button type="button" onClick={onClose} className="text-sm text-white/50 hover:text-white">
            Cancel
          </button>
        </div>
        <ul className="overflow-y-auto px-3 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))]">
          {PLAY_PROMPT_BANK.map((p) => {
            const answered = (answers[p.id] ?? '').trim() !== ''
            const isCurrent = p.id === current
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onPick(p.id)}
                  aria-current={isCurrent}
                  className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-3 text-left text-sm transition-colors hover:bg-[#E03131]/10 ${
                    isCurrent ? 'bg-[#E03131]/15 text-white' : 'text-white/85'
                  }`}
                >
                  <span>{p.text}</span>
                  {answered && (
                    <span className="shrink-0 font-semibold text-[#FF6B6B]" aria-label="Answered">
                      ✓
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

export function PlayPromptsStep({ play, update }: PlayStepProps) {
  // The prompt slot whose question is being replaced from the picker.
  const [pickerSlot, setPickerSlot] = useState<number | null>(null)

  // Puts the picked prompt in the slot being replaced. A prompt already shown
  // in another slot swaps places instead. Answers stay in the draft (only
  // shown prompts are saved), so picking an earlier prompt brings its answer back.
  function pickPrompt(slot: number, id: string) {
    setPickerSlot(null)
    const ids = [...play.promptIds]
    const other = ids.indexOf(id)
    if (other === slot) return
    if (other !== -1) ids[other] = ids[slot]
    ids[slot] = id
    update({ promptIds: ids })
  }

  return (
    <>
      <Heading title="In your own words" subtitle="Answer at least one." />
      <div className="space-y-4">
        {play.promptIds.map((id, i) => {
          const prompt = PLAY_PROMPT_BANK.find((p) => p.id === id)
          const answer = play.answers[id] ?? ''
          return (
            <div key={id} className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="font-semibold text-white">{promptText(id)}</p>
                <button
                  type="button"
                  onClick={() => setPickerSlot(i)}
                  className="shrink-0 text-sm text-[#E03131]/80 hover:text-red-400"
                >
                  ↻ Different question
                </button>
              </div>
              <textarea
                value={answer}
                onChange={(e) =>
                  update({
                    answers: {
                      ...play.answers,
                      [id]: e.target.value.slice(0, ANSWER_MAX),
                    },
                  })
                }
                maxLength={ANSWER_MAX}
                rows={3}
                placeholder={prompt?.placeholder ?? 'Your answer…'}
                className="mt-3 w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-white placeholder:text-white/30 focus:border-[#E03131]/50 focus:outline-none"
              />
              <p className="text-right text-xs text-white/30">
                {answer.length}/{ANSWER_MAX}
              </p>
            </div>
          )
        })}
      </div>
      {pickerSlot !== null && (
        <PlayPromptPicker
          current={play.promptIds[pickerSlot]}
          answers={play.answers}
          onPick={(id) => pickPrompt(pickerSlot, id)}
          onClose={() => setPickerSlot(null)}
        />
      )}
    </>
  )
}

export function PlayBioStep({
  bio,
  editing,
  busy,
  message,
  onChange,
  onGenerate,
  onWrite,
}: {
  bio: string
  editing: boolean
  busy: boolean
  message: string | null
  onChange: (bio: string) => void
  onGenerate: () => void
  onWrite: () => void
}) {
  return (
    <>
      <Heading title="Set the tone" subtitle="Tell people what to expect." />
      {editing ? (
        <>
          <textarea
            value={bio}
            onChange={(e) => onChange(e.target.value.slice(0, PLAY_BIO_MAX))}
            maxLength={PLAY_BIO_MAX}
            rows={6}
            disabled={busy}
            placeholder={busy ? 'Writing your bio…' : 'Your Play bio…'}
            className="w-full resize-none rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:border-[#E03131]/50 focus:outline-none disabled:opacity-60"
          />
          <div className="mt-2 flex items-center justify-between text-sm">
            <button
              type="button"
              onClick={onGenerate}
              disabled={busy}
              className="font-semibold text-red-400 hover:text-red-300 disabled:opacity-50"
            >
              {busy ? 'Generating…' : '↺ Generate my Play bio'}
            </button>
            <span className="text-white/30">
              {bio.length}/{PLAY_BIO_MAX}
            </span>
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <button
            type="button"
            onClick={onGenerate}
            className="w-full rounded-xl bg-[#E03131] py-3 font-semibold text-white transition-colors hover:bg-[#E03131]/90"
          >
            ↺ Generate my Play bio
          </button>
          <button type="button" onClick={onWrite} className="w-full py-2 text-sm text-white/50 hover:text-white">
            Write it myself
          </button>
        </div>
      )}
      {message && <p className="mt-3 text-sm text-red-400">{message}</p>}
    </>
  )
}

export function PlayReviewStep({
  play,
  photoUrl,
  error,
  notices,
}: {
  play: PlayDraft
  photoUrl: string | null
  error: string | null
  // Set after a successful save when some photos didn't publish yet.
  notices: string[] | null
}) {
  const spice = play.spiceLevel ? SPICE_META[play.spiceLevel] : null
  const firstAnswer = play.promptIds.find((id) => (play.answers[id] ?? '').trim())
  const arrangement = tagsIn(play.tags, 'arrangement')
  return (
    <>
      <Heading title="You're set." />
      <div className="space-y-5">
        {photoUrl && (
          <img src={photoUrl} alt="Your main Play photo" className="aspect-[3/4] w-full rounded-2xl object-cover" />
        )}
        {spice && (
          <span className="inline-block rounded-full border border-[#E03131]/40 bg-[#E03131]/20 px-3 py-1 text-sm text-red-400">
            {spice.emoji} {spice.label}
          </span>
        )}
        {play.bio.trim() && <p className="whitespace-pre-line text-lg leading-relaxed text-white/80">{play.bio}</p>}
        {arrangement.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {arrangement.map((t) => (
              <span
                key={t}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white/70"
              >
                {PLAY_TAG_LABELS[t].emoji} {PLAY_TAG_LABELS[t].label}
              </span>
            ))}
          </div>
        )}
        {firstAnswer && (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="text-sm text-white/40">{promptText(firstAnswer)}</p>
            <p className="mt-1 text-white">{play.answers[firstAnswer]}</p>
          </div>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        {notices && (
          <div className="space-y-1 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <p className="font-semibold">Your Play profile is saved.</p>
            {notices.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
