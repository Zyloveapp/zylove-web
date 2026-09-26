import {
  BODY_TYPE_LABELS,
  DEALBREAKER_LABELS,
  HAIR_COLOR_LABELS,
  SEEKING_TRAIT_LABELS,
  type DatingIntent,
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
import { CardSelect, ChipMultiSelect, FieldLabel, HeightPicker, NumberSelect, StepHeader } from './ui'

const SEEKING_BODY_OPTIONS = toOptions(BODY_TYPE_LABELS, (l) => `${l.emoji} ${l.label}`).filter(
  (o) => o.value !== 'prefer_not_to_say',
)
const HAIR_OPTIONS = toOptions(HAIR_COLOR_LABELS, (l) => l)
const SEEKING_TRAIT_OPTIONS = toOptions(SEEKING_TRAIT_LABELS, (l) => l)
const DEALBREAKER_OPTIONS = toOptions(DEALBREAKER_LABELS, (l) => l)

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
          className="h-4 w-4 accent-gray-900"
        />
        Doesn't matter to me
      </label>
      {!draft.seekingHeightNoPreference && (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <span className="w-10 text-sm text-gray-600">Min</span>
            <HeightPicker
              label="Minimum height"
              value={draft.seekingHeightMin}
              onChange={(seekingHeightMin) => update({ seekingHeightMin })}
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="w-10 text-sm text-gray-600">Max</span>
            <HeightPicker
              label="Maximum height"
              value={draft.seekingHeightMax}
              onChange={(seekingHeightMax) => update({ seekingHeightMax })}
            />
          </div>
          {rangeInvalid && <p className="text-sm text-red-600">Minimum height must be below the maximum.</p>}
        </div>
      )}

      <FieldLabel>Body type preference</FieldLabel>
      <ChipMultiSelect
        options={SEEKING_BODY_OPTIONS}
        value={draft.seekingBodyTypes}
        onChange={(seekingBodyTypes) => update({ seekingBodyTypes })}
      />

      <FieldLabel>Hair color preference</FieldLabel>
      <ChipMultiSelect
        options={HAIR_OPTIONS}
        value={draft.seekingHairColors}
        onChange={(seekingHairColors) => update({ seekingHairColors })}
        exclusive="no_preference"
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
      <p className="mt-4 text-center text-sm text-gray-500">
        Serious daters won't see casual profiles unless you both opt in.
      </p>
      {includesPlay(draft.intent) && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          You'll set up your Spark profile first. Play profile setup comes after Spark is complete.
        </p>
      )}
    </div>
  )
}

const AGE_OPTIONS = Array.from({ length: MAX_RANGE_AGE - MIN_AGE + 1 }, (_, i) => MIN_AGE + i)

export function DiscoveryStep({ draft, update }: StepProps) {
  return (
    <div>
      <StepHeader title="Who should you see?" subtitle="You can change this anytime." />
      <FieldLabel>Distance</FieldLabel>
      <div className="flex flex-wrap gap-2">
        {RADIUS_OPTIONS.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={draft.radiusMiles === d}
            onClick={() => update({ radiusMiles: d })}
            className={`rounded-full border px-3 py-1.5 text-sm ${
              draft.radiusMiles === d ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 text-gray-700'
            }`}
          >
            {d} mi
          </button>
        ))}
      </div>

      <FieldLabel hint={`Showing people aged ${draft.ageMin}–${draft.ageMax}`}>Age range</FieldLabel>
      <div className="flex items-center gap-3">
        <NumberSelect
          label="Minimum age"
          value={draft.ageMin}
          options={AGE_OPTIONS.filter((a) => a < draft.ageMax)}
          onChange={(ageMin) => update({ ageMin })}
        />
        <span className="text-gray-400">—</span>
        <NumberSelect
          label="Maximum age"
          value={draft.ageMax}
          options={AGE_OPTIONS.filter((a) => a > draft.ageMin)}
          onChange={(ageMax) => update({ ageMax })}
        />
      </div>
    </div>
  )
}
