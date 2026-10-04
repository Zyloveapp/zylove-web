import {
  BODY_TYPE_LABELS,
  DEALBREAKER_LABELS,
  SEEKING_TRAIT_LABELS,
  type DatingIntent,
  type Dealbreaker,
} from '../../types/profile'
import {
  MAX_RANGE_AGE,
  MIN_AGE,
  RADIUS_OPTIONS,
  heightToInches,
  includesPlay,
  toOptions,
  type Option,
  type StepProps,
} from './types'
import { CardSelect, ChipMultiSelect, FieldLabel, HeightPicker, StepHeader } from './ui'

const SEEKING_BODY_OPTIONS = toOptions(BODY_TYPE_LABELS, (l) => `${l.emoji} ${l.label}`).filter(
  (o) => o.value !== 'prefer_not_to_say',
)
const SEEKING_TRAIT_OPTIONS = toOptions(SEEKING_TRAIT_LABELS, (l) => l)
// Legacy kids keys (has_kids, wants_kids, doesnt_want_kids) score identically to
// their partner_* replacements, so only the partner_* keys are offered.
const LEGACY_KIDS_DEALBREAKERS: Dealbreaker[] = ['has_kids', 'wants_kids', 'doesnt_want_kids']
const DEALBREAKER_LABEL_OVERRIDES: Partial<Record<Dealbreaker, string>> = {
  partner_doesnt_want_kids: "Doesn't want kids",
  partner_wants_kids: 'Wants kids',
  partner_has_kids: 'Has kids',
}
const DEALBREAKER_OPTIONS = toOptions(DEALBREAKER_LABELS, (l) => l)
  .filter((o) => !LEGACY_KIDS_DEALBREAKERS.includes(o.value))
  .map((o) => ({ ...o, label: DEALBREAKER_LABEL_OVERRIDES[o.value] ?? o.label }))

const INTENT_OPTIONS: Option<DatingIntent>[] = [
  { value: 'spark', label: '🔵 Spark — Here for something real.', description: 'Serious dating, genuine connections.' },
  { value: 'play', label: '🔴 Play — Here for a good time.', description: 'Casual, honest, no games.' },
  { value: 'open', label: '✦ Both — Open to either.', description: 'Set up Spark now, add a Play profile after.' },
]

export function PhysicalPrefsStep({ draft, update }: StepProps) {
  const rangeInvalid =
    !draft.seekingHeightNoPreference && heightToInches(draft.seekingHeightMin) > heightToInches(draft.seekingHeightMax)

  return (
    <div>
      <StepHeader title="Physical preferences" subtitle="All optional. Skip anything that doesn't matter to you." />

      <FieldLabel>Height preference</FieldLabel>
      <label className="mb-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.seekingHeightNoPreference}
          onChange={(e) => update({ seekingHeightNoPreference: e.target.checked })}
          className="h-4 w-4 accent-[#1B4FD8]"
        />
        Doesn't matter to me
      </label>
      {!draft.seekingHeightNoPreference && (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <span className="w-10 text-sm text-white/60">Min</span>
            <HeightPicker
              label="Minimum height"
              value={draft.seekingHeightMin}
              onChange={(seekingHeightMin) => update({ seekingHeightMin })}
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="w-10 text-sm text-white/60">Max</span>
            <HeightPicker
              label="Maximum height"
              value={draft.seekingHeightMax}
              onChange={(seekingHeightMax) => update({ seekingHeightMax })}
            />
          </div>
          {rangeInvalid && <p className="text-sm text-red-400">Minimum height must be below the maximum.</p>}
        </div>
      )}

      <FieldLabel>Body type preference</FieldLabel>
      <ChipMultiSelect
        options={SEEKING_BODY_OPTIONS}
        value={draft.seekingBodyTypes}
        onChange={(seekingBodyTypes) => update({ seekingBodyTypes })}
      />
    </div>
  )
}

export function NeedsStep({ draft, update }: StepProps) {
  return (
    <div>
      <StepHeader title="What do you need?" subtitle="Optional. Traits you want — and dealbreakers you won't compromise on." />
      <FieldLabel>I need someone who is… (up to 5)</FieldLabel>
      <ChipMultiSelect
        options={SEEKING_TRAIT_OPTIONS}
        value={draft.seekingTraits}
        onChange={(seekingTraits) => update({ seekingTraits })}
        max={5}
      />
      <FieldLabel>Dealbreakers</FieldLabel>
      <ChipMultiSelect
        options={DEALBREAKER_OPTIONS}
        value={draft.dealbreakers}
        onChange={(dealbreakers) => update({ dealbreakers })}
      />
    </div>
  )
}

export function IntentStep({ draft, update }: StepProps) {
  return (
    <div>
      <StepHeader title="What are you here for?" subtitle="We keep it real here." />
      <CardSelect options={INTENT_OPTIONS} value={draft.intent} onChange={(intent) => update({ intent })} />
      <p className="mt-4 text-center text-sm text-white/50">
        Serious daters won't see casual profiles unless you both opt in.
      </p>
      {includesPlay(draft.intent) && (
        <p className="mt-3 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-200">
          You'll set up your Spark profile first. Play profile setup comes after Spark is complete.
        </p>
      )}
    </div>
  )
}

// Age range slider: 18 to 65, where the top end means "65 and over" (saved
// as MAX_RANGE_AGE so older profiles aren't cut off).
const SLIDER_MAX = 65

function AgeRangeSlider({ min, max, onChange }: { min: number; max: number; onChange: (min: number, max: number) => void }) {
  const hi = Math.min(max, SLIDER_MAX)
  const pct = (v: number) => ((v - MIN_AGE) / (SLIDER_MAX - MIN_AGE)) * 100
  const label = (v: number) => (v >= SLIDER_MAX ? `${SLIDER_MAX}+` : String(v))
  return (
    <div>
      <div className="mb-4 flex items-center justify-center gap-3">
        <span className="min-w-[4.5rem] rounded-full border border-white/15 bg-white/5 px-4 py-2 text-center text-xl font-semibold">
          {label(min)}
        </span>
        <span className="text-white/40">to</span>
        <span className="min-w-[4.5rem] rounded-full border border-white/15 bg-white/5 px-4 py-2 text-center text-xl font-semibold">
          {label(hi)}
        </span>
      </div>
      <div className="zy-dual-range relative h-10">
        <div className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full bg-white/10" />
        <div
          className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-[color:var(--zy-accent,#1B4FD8)]"
          style={{ left: `${pct(min)}%`, right: `${100 - pct(hi)}%` }}
        />
        <input
          type="range"
          aria-label="Minimum age"
          min={MIN_AGE}
          max={SLIDER_MAX}
          value={min}
          onChange={(e) => onChange(Math.min(Number(e.target.value), hi - 1), max)}
        />
        <input
          type="range"
          aria-label="Maximum age"
          min={MIN_AGE}
          max={SLIDER_MAX}
          value={hi}
          onChange={(e) => {
            const v = Math.max(Number(e.target.value), min + 1)
            onChange(min, v >= SLIDER_MAX ? MAX_RANGE_AGE : v)
          }}
        />
      </div>
    </div>
  )
}

export function DiscoveryStep({ draft, update }: StepProps) {
  const distances: { value: number | null; label: string }[] = [
    ...RADIUS_OPTIONS.map((d) => ({ value: d, label: `${d} mi` })),
    { value: null, label: 'No limit' },
  ]
  return (
    <div>
      <StepHeader title="Who should you see?" subtitle="You can change this anytime." />
      <FieldLabel>Distance</FieldLabel>
      <div className="flex flex-wrap gap-2">
        {distances.map((d) => (
          <button
            key={d.label}
            type="button"
            aria-pressed={draft.radiusMiles === d.value}
            onClick={() => update({ radiusMiles: d.value })}
            className={`rounded-full border px-4 py-2 text-sm font-medium ${
              draft.radiusMiles === d.value ? 'border-[color:var(--zy-accent,#1B4FD8)] bg-[color:var(--zy-accent,#1B4FD8)] text-white' : 'border-white/15 text-white/80'
            }`}
          >
            {d.label}
          </button>
        ))}
      </div>

      <FieldLabel>Age range</FieldLabel>
      <AgeRangeSlider
        min={draft.ageMin}
        max={draft.ageMax}
        onChange={(ageMin, ageMax) => update({ ageMin, ageMax })}
      />
    </div>
  )
}
