import {
  ATTRACTED_TO_LABELS,
  BODY_TYPE_LABELS,
  DRINKING_HABIT_LABELS,
  GENDER_LABELS,
  HABIT_TAG_LABELS,
  LIFESTYLE_TAG_LABELS,
  LOVE_LANGUAGE_LABELS,
  OPEN_TO_LABELS,
  OFF_MAP_GENDER_IDENTITIES,
  PARENTAL_CURRENT_LABELS,
  PARENTAL_INTENT_LABELS,
  PERSONALITY_TRAIT_LABELS,
  POLITICAL_VIEW_LABELS,
  RELATIONSHIP_STATUS_LABELS,
  RELATIONSHIP_VALUE_LABELS,
  RELIGION_LABELS,
  WEEKEND_VIBE_LABELS,
  feetInchesToCm,
  type DrinkingHabit,
  type ParentalCurrent,
  type ParentalIntent,
} from '../../types/profile'
import { toOptions, type StepProps } from './types'
import {
  CardMultiSelect,
  CardSelect,
  ChipMultiSelect,
  ChipSelect,
  FieldLabel,
  SkipLink,
  StepHeader,
  StyledSelect,
} from './ui'

const GENDER_OPTIONS = toOptions(GENDER_LABELS, (l) => l)
const ATTRACTED_TO_OPTIONS = toOptions(ATTRACTED_TO_LABELS, (l) => l)
const RELATIONSHIP_STATUS_OPTIONS = toOptions(RELATIONSHIP_STATUS_LABELS, (l) => l.label, (l) => l.description)
const OPEN_TO_OPTIONS = toOptions(OPEN_TO_LABELS, (l) => l.label)
const BODY_TYPE_OPTIONS = toOptions(BODY_TYPE_LABELS, (l) => `${l.emoji} ${l.label}`)
const LIFESTYLE_OPTIONS = toOptions(LIFESTYLE_TAG_LABELS, (l) => `${l.emoji} ${l.label}`, (l) => l.description)
const HABIT_OPTIONS = toOptions(HABIT_TAG_LABELS, (l) => `${l.emoji} ${l.label}`)
const DRINKING_OPTIONS = toOptions(DRINKING_HABIT_LABELS, (l) => l.label)
const PERSONALITY_OPTIONS = toOptions(PERSONALITY_TRAIT_LABELS, (l) => l)
const VALUE_OPTIONS = toOptions(RELATIONSHIP_VALUE_LABELS, (l) => l)
const WEEKEND_OPTIONS = toOptions(WEEKEND_VIBE_LABELS, (l) => `${l.emoji} ${l.label}`, (l) => l.description)
const LOVE_GIVE_OPTIONS = toOptions(LOVE_LANGUAGE_LABELS, (l) => `${l.emoji} ${l.label}`, (l) => l.giveDescription)
const LOVE_RECEIVE_OPTIONS = toOptions(LOVE_LANGUAGE_LABELS, (l) => `${l.emoji} ${l.label}`, (l) => l.receiveDescription)
const RELIGION_OPTIONS = toOptions(RELIGION_LABELS, (l) => l)
const POLITICS_OPTIONS = toOptions(POLITICAL_VIEW_LABELS, (l) => l.label, (l) => l.description)
const PARENTAL_CURRENT_OPTIONS = toOptions(PARENTAL_CURRENT_LABELS, (l) => l.label, (l) => l.description || undefined)

// Follow-up options depend on whether they already have kids (mirrors mobile).
const PARENTAL_INTENTS_BY_CURRENT: Record<ParentalCurrent, ParentalIntent[]> = {
  has_kids: ['wants_more', 'open_to_more', 'doesnt_want_more', 'undecided'],
  no_kids: ['wants_first', 'doesnt_want_any', 'undecided'],
}
const PARENTAL_INTENT_QUESTION: Record<ParentalCurrent, string> = {
  has_kids: 'Are you open to more kids with the right partner?',
  no_kids: "What's your take on having kids?",
}

function parentalIntentOptions(current: ParentalCurrent) {
  return toOptions(PARENTAL_INTENT_LABELS, (l) => l.label, (l) => l.description).filter((o) =>
    PARENTAL_INTENTS_BY_CURRENT[current].includes(o.value),
  )
}

const textInputClass = 'w-full rounded-lg border border-white/15 px-3 py-2 focus:border-[#1B4FD8] focus:outline-none'

export function GenderStep({ draft, update }: StepProps) {
  return (
    <div>
      <StepHeader title="I am…" subtitle="This helps us show you to the right people." />
      <ChipSelect
        options={GENDER_OPTIONS}
        value={draft.genderIdentity}
        onChange={(genderIdentity) =>
          update({
            genderIdentity,
            // matchableAs only applies to off-map identities.
            ...(genderIdentity && !OFF_MAP_GENDER_IDENTITIES.includes(genderIdentity) && { matchableAs: [] }),
          })
        }
      />
      {draft.genderIdentity === 'self_describe' && (
        <input
          type="text"
          maxLength={40}
          placeholder="Describe your gender"
          value={draft.genderSelfDescribe}
          onChange={(e) => update({ genderSelfDescribe: e.target.value })}
          className={`${textInputClass} mt-3`}
        />
      )}
      {draft.genderIdentity && OFF_MAP_GENDER_IDENTITIES.includes(draft.genderIdentity) && (
        <>
          <FieldLabel hint="Select at least one. This is how you'll be surfaced in Explore.">
            Show my profile to people attracted to…
          </FieldLabel>
          <ChipMultiSelect
            options={ATTRACTED_TO_OPTIONS}
            value={draft.matchableAs}
            onChange={(matchableAs) => update({ matchableAs })}
          />
        </>
      )}
      <FieldLabel>Pronouns (optional)</FieldLabel>
      <input
        type="text"
        maxLength={30}
        placeholder="he/him, she/her, they/them…"
        value={draft.pronouns}
        onChange={(e) => update({ pronouns: e.target.value })}
        className={textInputClass}
      />
    </div>
  )
}

export function AttractedToStep({ draft, update }: StepProps) {
  return (
    <div>
      <StepHeader
        title="I'm attracted to…"
        subtitle="Select all that apply. This is private and only used to show you relevant profiles."
      />
      <ChipMultiSelect
        options={ATTRACTED_TO_OPTIONS}
        value={draft.attractedTo}
        onChange={(attractedTo) => update({ attractedTo })}
        exclusive="everyone"
      />
    </div>
  )
}

export function RelationshipStep({ draft, update }: StepProps) {
  return (
    <div>
      <StepHeader title="Where are you at?" subtitle="Honesty here helps everyone — including you." />
      <FieldLabel>My relationship status</FieldLabel>
      <CardSelect
        options={RELATIONSHIP_STATUS_OPTIONS}
        value={draft.relationshipStatus}
        onChange={(relationshipStatus) => update({ relationshipStatus })}
      />
      <FieldLabel hint="Optional. Select all that apply.">I'm open to…</FieldLabel>
      <ChipMultiSelect options={OPEN_TO_OPTIONS} value={draft.openTo} onChange={(openTo) => update({ openTo })} />
    </div>
  )
}

export function BodyTypeStep({ draft, update, onSkip }: StepProps & { onSkip: () => void }) {
  return (
    <div>
      <StepHeader title="My body type" subtitle="Optional. This appears on your profile — be proud of it." />
      <ChipSelect
        options={BODY_TYPE_OPTIONS}
        value={draft.bodyType}
        onChange={(bodyType) => update({ bodyType })}
        allowDeselect
      />
      <SkipLink
        label="Skip for now"
        onClick={() => {
          update({ bodyType: null })
          onSkip()
        }}
      />
    </div>
  )
}

const FEET_OPTIONS = [4, 5, 6, 7].map((f) => ({ value: String(f), label: `${f} ft` }))
const INCH_OPTIONS = Array.from({ length: 12 }, (_, i) => ({ value: String(i), label: `${i} in` }))

export function HeightStep({ draft, update }: StepProps) {
  return (
    <div>
      <StepHeader title="My height" subtitle="Shown on your profile." />
      <div className="flex gap-2">
        <StyledSelect
          ariaLabel="Height feet"
          value={String(draft.height.feet)}
          options={FEET_OPTIONS}
          onChange={(v) => update({ height: { ...draft.height, feet: Number(v) } })}
          className="flex-1"
        />
        <StyledSelect
          ariaLabel="Height inches"
          value={String(draft.height.inches)}
          options={INCH_OPTIONS}
          onChange={(v) => update({ height: { ...draft.height, inches: Number(v) } })}
          className="flex-1"
        />
      </div>
      <p className="mt-2 text-sm text-white/50">{feetInchesToCm(draft.height.feet, draft.height.inches)} cm</p>
    </div>
  )
}

export function LifestyleStep({ draft, update }: StepProps) {
  return (
    <div>
      <StepHeader title="My lifestyle" subtitle="Pick up to 3 that feel most like you." />
      <CardMultiSelect
        options={LIFESTYLE_OPTIONS}
        value={draft.lifestyleTags}
        onChange={(lifestyleTags) => update({ lifestyleTags })}
        max={3}
      />
    </div>
  )
}

export function HabitsStep({ draft, update }: StepProps) {
  return (
    <div>
      <StepHeader title="My habits" subtitle="Select as many as feel true." />
      <ChipMultiSelect options={HABIT_OPTIONS} value={draft.habitTags} onChange={(habitTags) => update({ habitTags })} />
      <FieldLabel hint="Optional. This helps match you with people who are compatible.">Drinking</FieldLabel>
      <select
        value={draft.drinkingHabit ?? ''}
        onChange={(e) => update({ drinkingHabit: e.target.value === '' ? null : (e.target.value as DrinkingHabit) })}
        className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 focus:border-[#1B4FD8] focus:outline-none"
      >
        <option value="">—</option>
        {DRINKING_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

export function PersonalityStep({ draft, update }: StepProps) {
  return (
    <div>
      <StepHeader title="How would your friends describe you?" subtitle="Pick up to 3. Be honest — this shapes your bio." />
      <ChipMultiSelect
        options={PERSONALITY_OPTIONS}
        value={draft.personalityTraits}
        onChange={(personalityTraits) => update({ personalityTraits })}
        max={3}
      />
    </div>
  )
}

export function ValuesStep({ draft, update }: StepProps) {
  return (
    <div>
      <StepHeader title="What do you value most in a relationship?" subtitle="Pick up to 3." />
      <ChipMultiSelect
        options={VALUE_OPTIONS}
        value={draft.relationshipValues}
        onChange={(relationshipValues) => update({ relationshipValues })}
        max={3}
      />
    </div>
  )
}

export function WeekendStep({ draft, update }: StepProps) {
  return (
    <div>
      <StepHeader title="A perfect weekend looks like…" subtitle="Pick all that feel like you." />
      <CardMultiSelect
        options={WEEKEND_OPTIONS}
        value={draft.weekendVibes}
        onChange={(weekendVibes) => update({ weekendVibes })}
      />
    </div>
  )
}

export function LoveGiveStep({ draft, update }: StepProps) {
  return (
    <div>
      <StepHeader title="How do you show love?" subtitle="Pick your top 2. When I care about someone, I show it by…" />
      <CardMultiSelect
        options={LOVE_GIVE_OPTIONS}
        value={draft.loveLangGive}
        onChange={(loveLangGive) => update({ loveLangGive })}
        max={2}
      />
    </div>
  )
}

export function LoveReceiveStep({ draft, update }: StepProps) {
  return (
    <div>
      <StepHeader title="How do you receive love?" subtitle="Pick your top 2. I feel most loved when someone…" />
      <CardMultiSelect
        options={LOVE_RECEIVE_OPTIONS}
        value={draft.loveLangReceive}
        onChange={(loveLangReceive) => update({ loveLangReceive })}
        max={2}
      />
    </div>
  )
}

export function BeliefsStep({ draft, update, onSkip }: StepProps & { onSkip: () => void }) {
  return (
    <div>
      <StepHeader title="A little more about you" subtitle="Both optional. Skip anything you'd rather keep private." />
      <FieldLabel>Faith / Religion</FieldLabel>
      <ChipSelect
        options={RELIGION_OPTIONS}
        value={draft.religion}
        onChange={(religion) => update({ religion })}
        allowDeselect
      />
      <FieldLabel hint="Private — only used to match you with compatible people.">Political views</FieldLabel>
      <ChipSelect
        options={POLITICS_OPTIONS}
        value={draft.politicalView}
        onChange={(politicalView) => update({ politicalView })}
        allowDeselect
      />
      <SkipLink
        label="Skip — keep both private"
        onClick={() => {
          update({ religion: null, politicalView: null })
          onSkip()
        }}
      />
    </div>
  )
}

export function KidsStep({ draft, update, onSkip }: StepProps & { onSkip: () => void }) {
  return (
    <div>
      <StepHeader title="Kids?" subtitle="Optional. This helps match you with people who want the same things." />
      <FieldLabel>Do you have kids?</FieldLabel>
      <CardSelect
        options={PARENTAL_CURRENT_OPTIONS}
        value={draft.parentalCurrent}
        onChange={(parentalCurrent) =>
          update({
            parentalCurrent,
            // Drop a follow-up answer that doesn't apply to the new choice.
            ...(draft.parentalIntent &&
              !PARENTAL_INTENTS_BY_CURRENT[parentalCurrent].includes(draft.parentalIntent) && { parentalIntent: null }),
          })
        }
      />
      {draft.parentalCurrent && (
        <>
          <FieldLabel>{PARENTAL_INTENT_QUESTION[draft.parentalCurrent]}</FieldLabel>
          <CardSelect
            options={parentalIntentOptions(draft.parentalCurrent)}
            value={draft.parentalIntent}
            onChange={(parentalIntent) => update({ parentalIntent })}
          />
        </>
      )}
      <SkipLink
        label="Skip for now"
        onClick={() => {
          update({ parentalCurrent: null, parentalIntent: null })
          onSkip()
        }}
      />
    </div>
  )
}
