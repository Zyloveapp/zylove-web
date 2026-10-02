import type { PlayProfileData } from '../../services/playProfile'
import {
  PLAY_NON_NEGOTIABLE_LABELS,
  PLAY_TAG_LABELS,
  SPICE_META,
  type PlayInterestTag,
  type PlayNonNegotiable,
  type SpiceLevel,
} from '../../types/dualProfile'

// What two Play profiles have in common and where they clash. Feeds the Play
// "Why this works", Things in common and Worth a conversation sections.

const SPICE_ORDER: SpiceLevel[] = ['vanilla', 'spicy', 'blindfold', 'unleashed', 'no_limits']

export interface PlayFacts {
  mySpice: SpiceLevel | null
  theirSpice: SpiceLevel | null
  sharedArrangement: string[]
  sharedVibe: string[]
  sharedDynamic: string[]
  myArrangement: string[]
  theirArrangement: string[]
  theirRules: string[] // their non-negotiables
  conflicts: string[] // their non-negotiables your profile runs into
}

export interface PlayLine {
  label: string
  detail: string
}

function spiceOf(v: string | null): SpiceLevel | null {
  return v && (SPICE_ORDER as string[]).includes(v) ? (v as SpiceLevel) : null
}

function categoryOf(tag: string): string | null {
  return Object.prototype.hasOwnProperty.call(PLAY_TAG_LABELS, tag) ? PLAY_TAG_LABELS[tag as PlayInterestTag].category : null
}

function inCategory(tags: string[], category: string): string[] {
  return tags.filter((t) => categoryOf(t) === category)
}

function tagLabel(tag: string): string {
  return Object.prototype.hasOwnProperty.call(PLAY_TAG_LABELS, tag) ? PLAY_TAG_LABELS[tag as PlayInterestTag].label : tag.replace(/_/g, ' ')
}

function ruleLabel(rule: string): string {
  return Object.prototype.hasOwnProperty.call(PLAY_NON_NEGOTIABLE_LABELS, rule)
    ? PLAY_NON_NEGOTIABLE_LABELS[rule as PlayNonNegotiable]
    : rule.replace(/_/g, ' ')
}

function spiceLabel(level: SpiceLevel): string {
  return SPICE_META[level].label
}

function pair(tags: string[], joiner: string): string {
  const labels = tags.slice(0, 2).map(tagLabel)
  return labels.join(joiner)
}

// Their non-negotiables your profile visibly runs into. Only the ones a
// profile can actually contradict; safe-sex rules can't be checked from tags.
function conflictsWith(rules: string[], me: PlayProfileData, myRelationshipStatus: unknown): string[] {
  const mine = new Set(me.playInterestTags)
  return rules.filter((rule) => {
    switch (rule) {
      case 'singles_only':
        return (
          typeof myRelationshipStatus === 'string' &&
          myRelationshipStatus !== 'single' &&
          myRelationshipStatus !== 'prefer_not_to_say'
        )
      case 'no_chems':
        return mine.has('chem_friendly')
      case 'no_threesomes':
        return mine.has('threesome_mmf') || mine.has('threesome_ffm') || mine.has('group_open')
      case 'no_emotional_attachment':
        return mine.has('open_to_more')
      default:
        return false
    }
  })
}

export function comparePlay(me: PlayProfileData, them: PlayProfileData, myRelationshipStatus: unknown): PlayFacts {
  const theirTags = new Set(them.playInterestTags)
  const shared = me.playInterestTags.filter((t) => theirTags.has(t))
  return {
    mySpice: spiceOf(me.spiceLevel),
    theirSpice: spiceOf(them.spiceLevel),
    sharedArrangement: inCategory(shared, 'arrangement'),
    sharedVibe: inCategory(shared, 'vibe'),
    sharedDynamic: inCategory(shared, 'dynamic'),
    myArrangement: inCategory(me.playInterestTags, 'arrangement'),
    theirArrangement: inCategory(them.playInterestTags, 'arrangement'),
    theirRules: them.playNonNegotiables,
    conflicts: conflictsWith(them.playNonNegotiables, me, myRelationshipStatus),
  }
}

function spiceGap(f: PlayFacts): number | null {
  if (!f.mySpice || !f.theirSpice) return null
  return Math.abs(SPICE_ORDER.indexOf(f.mySpice) - SPICE_ORDER.indexOf(f.theirSpice))
}

// "Why this works" in Play: chemistry, not compatibility.
export function playWhyLines(f: PlayFacts): PlayLine[] {
  const lines: PlayLine[] = []
  const gap = spiceGap(f)
  if (gap !== null && f.mySpice && f.theirSpice) {
    lines.push({
      label: 'Spice level',
      detail:
        gap === 0
          ? `You're both ${spiceLabel(f.mySpice)} — you already speak the same language`
          : gap === 1
            ? `Your energy levels are compatible — ${spiceLabel(f.theirSpice)} meets ${spiceLabel(f.mySpice)}`
            : 'Different intensities — worth a conversation before anything else',
    })
  }
  if (f.sharedArrangement.length > 0) {
    lines.push({ label: 'Here for', detail: `You're both here for ${pair(f.sharedArrangement, ' & ')}` })
  }
  if (f.sharedVibe.length > 0) {
    lines.push({ label: 'Energy', detail: `Your energy: ${pair(f.sharedVibe, ' · ')}` })
  }
  if (f.sharedDynamic.length > 0) {
    lines.push({
      label: 'Dynamic',
      detail:
        f.sharedDynamic.length > 1
          ? `Compatible dynamics — ${tagLabel(f.sharedDynamic[0])} meets ${tagLabel(f.sharedDynamic[1])}`
          : `Compatible dynamics — you're both into ${tagLabel(f.sharedDynamic[0])}`,
    })
  }
  if (f.theirRules.length > 0) {
    lines.push({
      label: 'Their rules',
      detail:
        f.conflicts.length > 0
          ? `They require ${ruleLabel(f.conflicts[0]).toLowerCase()} — worth knowing upfront`
          : 'Their rules work for you',
    })
  }
  return lines
}

export function playCommons(f: PlayFacts): PlayLine[] {
  const labels = (tags: string[]) => tags.map(tagLabel).join(' · ')
  return [
    f.sharedVibe.length > 0 && { label: 'Shared energy', detail: labels(f.sharedVibe) },
    f.sharedArrangement.length > 0 && { label: 'Both here for', detail: labels(f.sharedArrangement) },
    f.sharedDynamic.length > 0 && { label: 'Compatible dynamic', detail: labels(f.sharedDynamic) },
  ].filter((l): l is PlayLine => Boolean(l))
}

// Direct, adult, not clinical.
const CONFLICT_COPY: Record<string, string> = {
  singles_only: "They're only meeting singles — be upfront about where you're at.",
  no_chems: 'They want it substance-free — are you good with that?',
  no_threesomes: "They're not into threesomes — know that before you bring it up.",
  no_emotional_attachment: 'They want to keep feelings out of it — does that work for you?',
}

export function playConversations(f: PlayFacts): PlayLine[] {
  const lines: PlayLine[] = []
  const gap = spiceGap(f)
  if (gap !== null && gap > 0 && f.mySpice && f.theirSpice) {
    lines.push({
      label: 'Different spice levels',
      detail:
        gap === 1
          ? `You're ${spiceLabel(f.mySpice)}, they're ${spiceLabel(f.theirSpice)} — close, but talk about where the line is.`
          : `You're ${spiceLabel(f.mySpice)}, they're ${spiceLabel(f.theirSpice)}. Talk about it before anything else.`,
    })
  }
  for (const rule of f.conflicts) {
    lines.push({ label: ruleLabel(rule), detail: CONFLICT_COPY[rule] ?? `They require ${ruleLabel(rule).toLowerCase()}.` })
  }
  if (f.theirRules.includes('discreet_required')) {
    lines.push({ label: 'Discretion', detail: 'They need discretion — are you able to offer that?' })
  }
  if (f.myArrangement.length > 0 && f.theirArrangement.length > 0 && f.sharedArrangement.length === 0) {
    lines.push({
      label: 'Different goals',
      detail: `You're after ${tagLabel(f.myArrangement[0])}, they're after ${tagLabel(f.theirArrangement[0])} — get clear on it early.`,
    })
  }
  return lines
}
