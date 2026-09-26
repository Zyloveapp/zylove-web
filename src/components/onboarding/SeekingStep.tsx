import type { ReactNode } from 'react'
import { ONBOARDING_COPY } from '../../brand/zylove'
import {
  DEALBREAKER_LABELS,
  RELATIONSHIP_VALUE_LABELS,
  SEEKING_TRAIT_LABELS,
  type Dealbreaker,
  type RelationshipValue,
  type SeekingTrait,
} from '../../types/profile'
import {
  BODY_TYPE_LABELS,
  HEIGHT_LABELS,
  type BodyTypePreference,
  type HeightPreference,
} from '../../types/preferences'
import Chip from './Chip'
import { toggleIn, type SeekingDraft } from './types'

const HEIGHTS = Object.keys(HEIGHT_LABELS) as HeightPreference[]
const BODY_TYPES = Object.keys(BODY_TYPE_LABELS) as BodyTypePreference[]
const TRAITS = Object.keys(SEEKING_TRAIT_LABELS) as SeekingTrait[]
const VALUES = Object.keys(RELATIONSHIP_VALUE_LABELS) as RelationshipValue[]
const DEALBREAKERS = Object.keys(DEALBREAKER_LABELS) as Dealbreaker[]

const MAX_SEEKING_TRAITS = 5
const MAX_TOP_VALUES = 3

interface SeekingStepProps {
  value: SeekingDraft
  onChange: (patch: Partial<SeekingDraft>) => void
}

export default function SeekingStep({ value, onChange }: SeekingStepProps) {
  // "No preference" is exclusive with specific body types.
  function toggleBodyType(b: BodyTypePreference) {
    if (b === 'no_preference') {
      onChange({ bodyTypePreference: value.bodyTypePreference.includes(b) ? [] : [b] })
      return
    }
    onChange({ bodyTypePreference: toggleIn(value.bodyTypePreference.filter((x) => x !== 'no_preference'), b) })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{ONBOARDING_COPY.seeking.title}</h1>
        <p className="rounded-lg bg-gray-100 p-3 text-sm text-gray-700">🔒 {ONBOARDING_COPY.seeking.privacy}</p>
      </div>

      <Section title={`Traits you're drawn to (1–${MAX_SEEKING_TRAITS})`}>
        {TRAITS.map((t) => (
          <Chip
            key={t}
            label={SEEKING_TRAIT_LABELS[t]}
            selected={value.seekingTraits.includes(t)}
            disabled={value.seekingTraits.length >= MAX_SEEKING_TRAITS}
            onClick={() => onChange({ seekingTraits: toggleIn(value.seekingTraits, t, MAX_SEEKING_TRAITS) })}
          />
        ))}
      </Section>

      <Section title={`What matters most (up to ${MAX_TOP_VALUES})`}>
        {VALUES.map((v) => (
          <Chip
            key={v}
            label={RELATIONSHIP_VALUE_LABELS[v]}
            selected={value.topValues.includes(v)}
            disabled={value.topValues.length >= MAX_TOP_VALUES}
            onClick={() => onChange({ topValues: toggleIn(value.topValues, v, MAX_TOP_VALUES) })}
          />
        ))}
      </Section>

      <Section title="Height">
        {HEIGHTS.map((h) => (
          <Chip
            key={h}
            label={HEIGHT_LABELS[h]}
            selected={value.heightPreference === h}
            onClick={() => onChange({ heightPreference: h })}
          />
        ))}
      </Section>

      <Section title="Body type (optional)">
        {BODY_TYPES.map((b) => (
          <Chip
            key={b}
            label={BODY_TYPE_LABELS[b]}
            selected={value.bodyTypePreference.includes(b)}
            onClick={() => toggleBodyType(b)}
          />
        ))}
      </Section>

      <Section title="Dealbreakers (optional)">
        {DEALBREAKERS.map((d) => (
          <Chip
            key={d}
            label={DEALBREAKER_LABELS[d]}
            selected={value.dealbreakers.includes(d)}
            onClick={() => onChange({ dealbreakers: toggleIn(value.dealbreakers, d) })}
          />
        ))}
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-gray-700">{title}</legend>
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  )
}
