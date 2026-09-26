import {
  ATTRACTED_TO_LABELS,
  GENDER_LABELS,
  type AttractedTo,
  type GenderIdentity,
} from '../../types/profile'
import Chip from './Chip'
import { MIN_AGE, parseAge, toggleIn, type OnboardingDraft } from './types'

const GENDERS = Object.keys(GENDER_LABELS) as GenderIdentity[]
const ATTRACTED_TO = Object.keys(ATTRACTED_TO_LABELS) as AttractedTo[]

type BasicFields = Pick<OnboardingDraft, 'displayName' | 'age' | 'genderIdentity' | 'genderSelfDescribe' | 'attractedTo'>

interface BasicInfoStepProps {
  value: BasicFields
  onChange: (patch: Partial<BasicFields>) => void
}

export default function BasicInfoStep({ value, onChange }: BasicInfoStepProps) {
  const ageTouched = value.age.trim() !== ''
  const ageInvalid = ageTouched && parseAge(value.age) === null

  // "Everyone" is exclusive with the specific options.
  function toggleAttractedTo(a: AttractedTo) {
    if (a === 'everyone') {
      onChange({ attractedTo: value.attractedTo.includes('everyone') ? [] : ['everyone'] })
      return
    }
    onChange({ attractedTo: toggleIn(value.attractedTo.filter((x) => x !== 'everyone'), a) })
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">The basics</h1>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-gray-700">First name</span>
        <input
          type="text"
          autoComplete="given-name"
          maxLength={30}
          value={value.displayName}
          onChange={(e) => onChange({ displayName: e.target.value })}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-gray-800 focus:outline-none"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-gray-700">Age</span>
        <input
          type="text"
          inputMode="numeric"
          maxLength={3}
          value={value.age}
          onChange={(e) => onChange({ age: e.target.value.replace(/\D/g, '') })}
          className="w-28 rounded-lg border border-gray-300 px-3 py-2 focus:border-gray-800 focus:outline-none"
        />
        {ageInvalid && (
          <p className="text-sm text-red-600">You must be {MIN_AGE} or older to use Zylove.</p>
        )}
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-gray-700">I am…</legend>
        <div className="flex flex-wrap gap-2">
          {GENDERS.map((g) => (
            <Chip
              key={g}
              label={GENDER_LABELS[g]}
              selected={value.genderIdentity === g}
              onClick={() => onChange({ genderIdentity: g })}
            />
          ))}
        </div>
        {value.genderIdentity === 'self_describe' && (
          <input
            type="text"
            maxLength={40}
            placeholder="Describe your gender"
            value={value.genderSelfDescribe}
            onChange={(e) => onChange({ genderSelfDescribe: e.target.value })}
            className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-gray-800 focus:outline-none"
          />
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-gray-700">Interested in</legend>
        <div className="flex flex-wrap gap-2">
          {ATTRACTED_TO.map((a) => (
            <Chip
              key={a}
              label={ATTRACTED_TO_LABELS[a]}
              selected={value.attractedTo.includes(a)}
              onClick={() => toggleAttractedTo(a)}
            />
          ))}
        </div>
      </fieldset>
    </div>
  )
}
