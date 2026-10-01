import {
  CONFLICT_STYLE_LABELS,
  STRESS_RESPONSE_LABELS,
  TOGETHERNESS_STYLE_LABELS,
} from '../onboarding/types'
import type { DiscoverProfile } from '../../services/discover'

export type GoDeeperKey = 'conflictStyle' | 'togethernessStyle' | 'stressResponse'

// The three Go Deeper questions, worded as in onboarding. Labels are the
// first-person onboarding answers (the discover labels are third-person).
export const GO_DEEPER_QUESTIONS: { key: GoDeeperKey; question: string; short: string; labels: Record<string, string> }[] = [
  { key: 'conflictStyle', question: 'When conflict comes up…', short: 'In conflict', labels: CONFLICT_STYLE_LABELS },
  { key: 'togethernessStyle', question: 'In a relationship, I need…', short: 'Together time', labels: TOGETHERNESS_STYLE_LABELS },
  { key: 'stressResponse', question: "When I'm stressed, I…", short: 'Under stress', labels: STRESS_RESPONSE_LABELS },
]

export type GoDeeperAnswers = Partial<Record<GoDeeperKey, string>>

export function goDeeperAnswers(p: DiscoverProfile): GoDeeperAnswers {
  const raw = p as Record<string, unknown>
  const answers: GoDeeperAnswers = {}
  for (const { key } of GO_DEEPER_QUESTIONS) {
    const v = raw[key]
    if (typeof v === 'string' && v) answers[key] = v
  }
  return answers
}

export function goDeeperComplete(a: GoDeeperAnswers): boolean {
  return GO_DEEPER_QUESTIONS.every((q) => a[q.key] !== undefined)
}

// Answered questions as display rows; unknown stored keys are humanized.
export function goDeeperAnswerRows(a: GoDeeperAnswers): { label: string; value: string }[] {
  return GO_DEEPER_QUESTIONS.flatMap((q) => {
    const v = a[q.key]
    if (!v) return []
    const label = Object.prototype.hasOwnProperty.call(q.labels, v) ? q.labels[v] : v.replace(/_/g, ' ')
    return [{ label: q.short, value: label }]
  })
}
