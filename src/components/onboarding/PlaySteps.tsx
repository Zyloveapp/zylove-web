import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  PLAY_NON_NEGOTIABLE_LABELS,
  PLAY_PROMPT_BANK,
  PLAY_TAG_LABELS,
  SPICE_META,
  type PlayInterestTag,
  type PlayNonNegotiable,
  type SpiceLevel,
} from '../../types/dualProfile'
import { feetInchesToCm } from '../../types/profile'
import {
  PLAY_BODY_HAIR_LABELS,
  PLAY_BODY_TYPE_LABELS,
  PLAY_ENERGY_LABELS,
  PLAY_GROOMING_LABELS,
  TYPE_PREFERENCE_FIELDS,
  playDescriptorLabels,
  typePreferenceLabels,
  type TypePreferences,
} from '../../types/playDescriptors'
import {
  MAX_PLAY_PROMPTS,
  MIN_PLAY_ANSWERS,
  answeredGoDeeper,
  generatePlayGoDeeper,
  playAnswerCount,
  tagsIn,
  type GoDeeperResult,
  type PlayDraft,
  type PlayTagCategory,
} from '../../services/playOnboarding'
import { HeightPicker } from './ui'

// The Play steps, shared by the Play-only path in /onboarding and by
// /play-onboarding (mode-pill setup and Play edits).

export const PLAY_BIO_MAX = 300
const ANSWER_MAX = 200
// Prompts every user gets; more can be added up to MAX_PLAY_PROMPTS.
const BASE_PROMPTS = 3
const DEFAULT_HEIGHT_CM = feetInchesToCm(5, 8)

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

function GroupTitle({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-sm font-semibold uppercase tracking-widest text-[#E03131]/80">{children}</p>
}

// Single-select pills; tapping the selected one clears it (every field here
// is optional).
function SinglePills<T extends string>({
  labels,
  value,
  onChange,
}: {
  labels: Record<T, string>
  value: T | null
  onChange: (value: T | null) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {(Object.keys(labels) as T[]).map((k) => (
        <Pill key={k} selected={value === k} onClick={() => onChange(value === k ? null : k)}>
          {labels[k]}
        </Pill>
      ))}
    </div>
  )
}

function cmToFeetInches(cm: number): { feet: number; inches: number } {
  const total = Math.round(cm / 2.54)
  return { feet: Math.floor(total / 12), inches: total % 12 }
}

// /play-onboarding only — the Play-only path's recommendation screen already
// carries this reassurance.
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

// Height and body type arrive pre-filled from the Spark profile when there is
// one; everything stays editable and optional.
export function AboutYouStep({ play, update }: PlayStepProps) {
  return (
    <>
      <Heading title="A little about you" subtitle="This shows on your Play profile and helps match your energy." />
      <div className="space-y-6">
        <section>
          <GroupTitle>Body type</GroupTitle>
          <SinglePills labels={PLAY_BODY_TYPE_LABELS} value={play.bodyType} onChange={(bodyType) => update({ bodyType })} />
        </section>
        <section>
          <GroupTitle>Height</GroupTitle>
          {play.heightCm === null ? (
            <button
              type="button"
              onClick={() => update({ heightCm: DEFAULT_HEIGHT_CM })}
              className="rounded-full border border-white/10 bg-white/5 px-3.5 py-2 text-sm text-white/70 hover:border-white/25"
            >
              + Add height
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <HeightPicker
                label="Height"
                value={cmToFeetInches(play.heightCm)}
                onChange={(h) => update({ heightCm: feetInchesToCm(h.feet, h.inches) })}
              />
              <button type="button" onClick={() => update({ heightCm: null })} className="text-sm text-white/40 hover:text-white">
                Clear
              </button>
            </div>
          )}
        </section>
        <section>
          <GroupTitle>Body hair</GroupTitle>
          <SinglePills labels={PLAY_BODY_HAIR_LABELS} value={play.bodyHair} onChange={(bodyHair) => update({ bodyHair })} />
        </section>
        <section>
          <GroupTitle>Grooming</GroupTitle>
          <SinglePills labels={PLAY_GROOMING_LABELS} value={play.grooming} onChange={(grooming) => update({ grooming })} />
        </section>
        <section>
          <GroupTitle>Energy</GroupTitle>
          <SinglePills labels={PLAY_ENERGY_LABELS} value={play.energy} onChange={(energy) => update({ energy })} />
        </section>
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
                    <Pill key={t} selected={play.tags.includes(t)} onClick={() => update({ tags: toggle(play.tags, t) })}>
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
      <Heading title="My non-negotiables" subtitle="What you always need. Others see this — it filters who reaches out." />
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

export function MyTypeStep({ play, update }: PlayStepProps) {
  const set = (key: keyof TypePreferences, value: string | null) =>
    update({ typePreferences: { ...play.typePreferences, [key]: value } })
  return (
    <>
      <Heading title="My type in this space" subtitle="Optional. Shows on your profile. Helps us find your match." />
      <div className="space-y-6">
        {TYPE_PREFERENCE_FIELDS.map(({ key, title, labels }) => (
          <section key={key}>
            <GroupTitle>{title}</GroupTitle>
            <SinglePills labels={labels} value={play.typePreferences[key]} onChange={(v) => set(key, v)} />
          </section>
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

function AnswerBox({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  disabled?: boolean
}) {
  return (
    <>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, ANSWER_MAX))}
        maxLength={ANSWER_MAX}
        rows={3}
        disabled={disabled}
        placeholder={placeholder}
        className="mt-3 w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-white placeholder:text-white/30 focus:border-[#E03131]/50 focus:outline-none disabled:opacity-50"
      />
      <p className="text-right text-xs text-white/30">
        {value.length}/{ANSWER_MAX}
      </p>
    </>
  )
}

// One request at a time across mounts: leaving the step mid-request and
// coming back reuses it instead of spending another weekly generation.
let goDeeperInFlight: Promise<GoDeeperResult> | null = null
function requestGoDeeper(play: PlayDraft): Promise<GoDeeperResult> {
  goDeeperInFlight ??= generatePlayGoDeeper(play).finally(() => {
    goDeeperInFlight = null
  })
  return goDeeperInFlight
}

type GoDeeperStatus = 'idle' | 'loading' | 'failed' | 'limit'

// Standard prompts plus two AI-written Go Deeper questions. Any three answers
// across both sections unlock Next (see playAnswerCount).
export function PlayPromptsStep({ play, update }: PlayStepProps) {
  // The prompt slot whose question is being replaced (or added) from the picker.
  const [pickerSlot, setPickerSlot] = useState<number | null>(null)
  const [status, setStatus] = useState<GoDeeperStatus>(() => (play.goDeeper.length === 0 ? 'loading' : 'idle'))
  const requested = useRef(false)

  // Answered Go Deeper questions survive a regenerate; the rest are replaced.
  function apply(result: GoDeeperResult, current: PlayDraft) {
    if ('error' in result) return setStatus(result.error)
    const kept = current.goDeeper.filter((g) => g.answer.trim())
    const fresh = result.questions
      .filter((q) => !kept.some((k) => k.question === q))
      .slice(0, 2 - kept.length)
      .map((question) => ({ question, answer: '' }))
    update({ goDeeper: [...kept, ...fresh] })
    setStatus('idle')
  }

  // Generated once, when the step first opens with no questions yet.
  useEffect(() => {
    if (requested.current || play.goDeeper.length > 0) return
    requested.current = true
    requestGoDeeper(play).then((result) => apply(result, play))
    // Mount only: later edits must not trigger another generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function regenerate() {
    setStatus('loading')
    requestGoDeeper(play).then((result) => apply(result, play))
  }

  // Puts the picked prompt in the slot being replaced, or appends it for a
  // new slot. A prompt already shown in another slot swaps places instead.
  // Answers stay in the draft (only shown prompts are saved), so picking an
  // earlier prompt brings its answer back.
  function pickPrompt(slot: number, id: string) {
    setPickerSlot(null)
    const ids = [...play.promptIds]
    const other = ids.indexOf(id)
    if (slot === ids.length) {
      if (other === -1) update({ promptIds: [...ids, id] })
      return
    }
    if (other === slot) return
    if (other !== -1) ids[other] = ids[slot]
    ids[slot] = id
    update({ promptIds: ids })
  }

  const count = playAnswerCount(play)
  const met = count >= MIN_PLAY_ANSWERS
  const allGoDeeperAnswered = play.goDeeper.length === 2 && answeredGoDeeper(play).length === 2

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">In your own words</h1>
          <p className="mt-1 text-white/50">Answer any {MIN_PLAY_ANSWERS} across both sections.</p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold ${
            met ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400' : 'border-white/15 bg-white/5 text-white/60'
          }`}
        >
          {Math.min(count, MIN_PLAY_ANSWERS)} of {MIN_PLAY_ANSWERS} required
        </span>
      </div>

      <div className="space-y-4">
        {play.promptIds.map((id, i) => {
          const prompt = PLAY_PROMPT_BANK.find((p) => p.id === id)
          return (
            <div key={id} className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="font-semibold text-white">{promptText(id)}</p>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <button
                    type="button"
                    onClick={() => setPickerSlot(i)}
                    className="text-sm text-[#E03131]/80 hover:text-red-400"
                  >
                    ↻ Different question
                  </button>
                  {i >= BASE_PROMPTS && (
                    <button
                      type="button"
                      onClick={() => update({ promptIds: play.promptIds.filter((p) => p !== id) })}
                      className="text-xs text-white/40 hover:text-white"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
              <AnswerBox
                value={play.answers[id] ?? ''}
                onChange={(answer) => update({ answers: { ...play.answers, [id]: answer } })}
                placeholder={prompt?.placeholder ?? 'Your answer…'}
              />
            </div>
          )
        })}
      </div>
      {play.promptIds.length < MAX_PLAY_PROMPTS && (
        <button
          type="button"
          onClick={() => setPickerSlot(play.promptIds.length)}
          className="mt-3 text-sm font-semibold text-red-400 hover:text-red-300"
        >
          + Add another prompt
        </button>
      )}

      <section className="mt-10">
        <h2 className="text-xl font-bold text-white">Go Deeper 🔥</h2>
        <p className="mt-1 text-white/50">These questions were written just for you based on your profile.</p>
        <div className="mt-4 space-y-4">
          {status === 'loading' && play.goDeeper.length === 0 && (
            <div className="flex items-center gap-3 rounded-2xl border border-[#E03131]/25 bg-[#E03131]/5 p-4 text-white/70">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-[#E03131]" aria-hidden />
              Generating your questions...
            </div>
          )}
          {play.goDeeper.map((g, i) => (
            <div key={g.question} className="rounded-2xl border border-[#E03131]/25 bg-[#E03131]/5 p-4">
              <p className="font-semibold text-white">{g.question}</p>
              <AnswerBox
                value={g.answer}
                onChange={(answer) => update({ goDeeper: play.goDeeper.map((q, j) => (j === i ? { ...q, answer } : q)) })}
                placeholder="Optional — your answer…"
                disabled={status === 'loading'}
              />
            </div>
          ))}
        </div>
        {status === 'failed' && <p className="mt-3 text-sm text-red-400">Couldn't generate questions right now.</p>}
        {status === 'limit' && (
          <p className="mt-3 text-sm text-red-400">
            You've used this week's 3 Go Deeper generations. Answer the prompts above instead.
          </p>
        )}
        {status !== 'limit' && !allGoDeeperAnswered && (
          <button
            type="button"
            onClick={regenerate}
            disabled={status === 'loading'}
            className="mt-3 text-sm font-semibold text-red-400 hover:text-red-300 disabled:opacity-50"
          >
            {status === 'loading' ? 'Generating…' : play.goDeeper.length > 0 ? '↻ Regenerate questions' : '↻ Try again'}
          </button>
        )}
      </section>

      {pickerSlot !== null && (
        <PlayPromptPicker
          current={play.promptIds[pickerSlot] ?? ''}
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

function Chips({ items, tone = 'neutral' }: { items: string[]; tone?: 'neutral' | 'red' }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <span
          key={item}
          className={`rounded-full border px-3 py-1.5 text-sm ${
            tone === 'red' ? 'border-[#E03131]/40 bg-[#E03131]/15 text-red-300' : 'border-white/10 bg-white/5 text-white/70'
          }`}
        >
          {item}
        </span>
      ))}
    </div>
  )
}

function QA({ question, answer, accent }: { question: string; answer: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 ${accent ? 'border-[#E03131]/25 bg-[#E03131]/5' : 'border-white/10 bg-white/5'}`}>
      <p className="text-sm text-white/40">{question}</p>
      <p className="mt-1 text-white">{answer}</p>
    </div>
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
  const [sceneOpen, setSceneOpen] = useState(false)
  const spice = play.spiceLevel ? SPICE_META[play.spiceLevel] : null
  const descriptors = playDescriptorLabels({
    playHeight: play.heightCm,
    playBodyType: play.bodyType,
    playBodyHair: play.bodyHair,
    playGrooming: play.grooming,
    playEnergy: play.energy,
  })
  const arrangement = tagsIn(play.tags, 'arrangement')
  const scene = SCENE_SECTIONS.map((s) => ({ ...s, tags: tagsIn(play.tags, s.category) })).filter((s) => s.tags.length > 0)
  const sceneCount = scene.reduce((n, s) => n + s.tags.length, 0)
  const myType = typePreferenceLabels(play.typePreferences)
  const prompts = play.promptIds.filter((id) => (play.answers[id] ?? '').trim())
  const goDeeper = answeredGoDeeper(play)
  const tagLabel = (t: PlayInterestTag) => `${PLAY_TAG_LABELS[t].emoji} ${PLAY_TAG_LABELS[t].label}`

  return (
    <>
      <Heading title="You're ready. 🔥" />
      <div className="space-y-5">
        {photoUrl && <img src={photoUrl} alt="Your main Play photo" className="aspect-[3/4] w-full rounded-2xl object-cover" />}
        {spice && (
          <span className="inline-block rounded-full border border-[#E03131]/40 bg-[#E03131]/20 px-3 py-1 text-sm text-red-400">
            {spice.emoji} {spice.label}
          </span>
        )}
        {descriptors.length > 0 && <Chips items={descriptors} />}
        {play.bio.trim() && <p className="whitespace-pre-line text-lg leading-relaxed text-white/80">{play.bio}</p>}
        {arrangement.length > 0 && <Chips items={arrangement.map(tagLabel)} />}
        {sceneCount > 0 && (
          <section>
            <button
              type="button"
              onClick={() => setSceneOpen((o) => !o)}
              aria-expanded={sceneOpen}
              className="flex w-full items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left text-sm text-white/70"
            >
              <span>
                Your scene: {sceneCount} selected across {scene.length} {scene.length === 1 ? 'category' : 'categories'}
              </span>
              <span className="text-white/40">{sceneOpen ? '−' : '+'}</span>
            </button>
            {sceneOpen && (
              <div className="mt-3 space-y-3">
                {scene.map((s) => (
                  <div key={s.category}>
                    <GroupTitle>{s.title}</GroupTitle>
                    <Chips items={s.tags.map(tagLabel)} />
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
        {play.nonNegotiables.length > 0 && (
          <section>
            <GroupTitle>Non-negotiables</GroupTitle>
            <Chips items={play.nonNegotiables.map((k) => `🔒 ${PLAY_NON_NEGOTIABLE_LABELS[k]}`)} />
          </section>
        )}
        {myType.length > 0 && (
          <section>
            <GroupTitle>My type</GroupTitle>
            <Chips items={myType} tone="red" />
          </section>
        )}
        {prompts.map((id) => (
          <QA key={id} question={promptText(id)} answer={play.answers[id]} />
        ))}
        {goDeeper.map((g) => (
          <QA key={g.question} question={g.question} answer={g.answer} accent />
        ))}
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

// After the first save, for people on the 30-day trial — not women, founders
// or Elite, who have Play without one.
export function PlayTrialWelcome({ onContinue }: { onContinue: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="play-trial-welcome-title"
    >
      <div className="w-full rounded-t-2xl border border-[#E03131]/30 bg-[#140707] px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-sm lg:rounded-2xl lg:pb-6">
        <h2 id="play-trial-welcome-title" className="text-2xl font-bold">
          😈 Welcome to Play
        </h2>
        <div className="mt-3 space-y-3 text-white/70">
          <p>You have 30 days to explore — on us. No card required.</p>
          <p>After 30 days, a subscription is required to keep your Play access.</p>
          <p>Your remaining days show in Settings so you always know where you stand.</p>
        </div>
        <button
          type="button"
          onClick={onContinue}
          autoFocus
          className="mt-6 w-full rounded-xl bg-[#E03131] py-3 font-semibold text-white transition-opacity hover:opacity-90"
        >
          Let's go 🔥
        </button>
      </div>
    </div>
  )
}
