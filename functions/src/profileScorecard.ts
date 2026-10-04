// Profile review scorecard — the JSON shape both "How's my profile?" reviews
// (Spark: reviewProfile, Play: reviewPlayProfile) ask Claude for, and the
// strict parser that turns its reply into something the client can render.

export interface ScorecardSection {
  name: string
  score: number
  working: string
  improve: string
}

export interface PhotoFeedback {
  score: number
  working: string
  improve: string
  suggestions: string[]
}

export interface ProfileScorecard {
  overallScore: number
  sections: ScorecardSection[]
  topSuggestion: string
  // Only when the user consented to photo coaching and photos were sent.
  photos?: PhotoFeedback
}

export const SPARK_REVIEW_SECTIONS = ['Clarity', 'Authenticity', 'Depth', 'Appeal'] as const
export const PLAY_REVIEW_SECTIONS = ['Clarity', 'Consistency', 'Tone', 'Appeal'] as const

const MAX_TEXT = 300
const MAX_PHOTO_SUGGESTIONS = 4

// Both reviews are read by the person being reviewed.
export const SECOND_PERSON_RULE = `IMPORTANT: Address the user directly in second person throughout.
Use 'you' and 'your' not 'they' and 'their'.
Example: 'Your type section lists preferences...' not 'Their type section lists preferences...'
The user is reading this review about themselves.`

// Goes right after the image blocks, which come first in the message.
export function photoReviewSection(mode: 'spark' | 'play', count: number): string {
  return [
    '── YOUR PHOTOS ──',
    `The ${count} image${count === 1 ? '' : 's'} above ${count === 1 ? 'is' : 'are'} this profile's photo${count === 1 ? '' : 's'}, in profile order — the first is the main photo.`,
    '',
    'Photo review criteria:',
    '- Main photo: face clearly visible, good lighting, authentic expression',
    '- Variety: different backgrounds, contexts, moods across photos',
    '- Alignment: do photos match the energy/spice level stated in the profile?',
    '- Authenticity: look recent, natural, not overly filtered',
    '- Red flags: face hidden, group photos as main, sunglasses in all photos',
    ...(mode === 'play' ? ['- Play-specific: do photos convey the stated spice level and energy appropriately'] : []),
  ].join('\n')
}

// The output contract appended to both review prompts. Section names are
// fixed so the client can rely on them.
export function scorecardInstructions(sections: readonly string[], { photos = false } = {}): string {
  const example = {
    overallScore: 78,
    sections: sections.map((name) => ({
      name,
      score: 0,
      working: 'One specific sentence about what works, referencing your actual profile.',
      improve: 'One specific, actionable sentence about what to change.',
    })),
    topSuggestion: 'The single most impactful change you could make, in one sentence.',
    ...(photos && {
      photos: {
        score: 0,
        working: 'One specific sentence about what works across the photos.',
        improve: 'One specific sentence about what to change in the photos.',
        suggestions: ['A short, concrete photo change', 'Another, referencing a specific photo by position'],
      },
    }),
  }
  return [
    '── OUTPUT FORMAT ──',
    'Return ONLY valid JSON in exactly this structure — no markdown, no code fences, no prose, no explanation:',
    JSON.stringify(example, null, 2),
    '',
    `- "sections" must contain exactly these ${sections.length} sections, in this order: ${sections.join(', ')}`,
    '- Every score is a whole number from 0 to 100; replace the placeholder scores with your real assessment',
    '- "overallScore" reflects the profile as a whole, not just the average of the sections',
    '- "working" and "improve" are one sentence each, under 25 words, specific to this profile',
    '- "topSuggestion" is the one thing to act on first',
    photos
      ? '- "photos" reviews the photos against the criteria above; "suggestions" is 1–4 short, concrete changes'
      : '- There are no photos to review: do not include a "photos" field',
  ].join('\n')
}

function score(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.max(0, Math.min(100, v))) : null
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_TEXT) : null
}

// The JSON object in Claude's reply, tolerating a stray code fence or a
// sentence around it. Null when it isn't the expected scorecard — the
// caller treats that as a failed review.
export function parseScorecard(
  reply: string,
  sections: readonly string[],
  { photos: withPhotos = false } = {},
): ProfileScorecard | null {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let raw: unknown
  try {
    raw = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const d = raw as Record<string, unknown>
  const overallScore = score(d.overallScore)
  const topSuggestion = text(d.topSuggestion)
  const list = Array.isArray(d.sections) ? d.sections : []
  if (overallScore === null || !topSuggestion) return null
  const photos = withPhotos ? parsePhotos(d.photos) : null

  const parsed: ScorecardSection[] = []
  for (const name of sections) {
    const s = list.find(
      (x): x is Record<string, unknown> =>
        typeof x === 'object' && x !== null && String((x as Record<string, unknown>).name).toLowerCase() === name.toLowerCase(),
    )
    const sectionScore = score(s?.score)
    const working = text(s?.working)
    const improve = text(s?.improve)
    if (sectionScore === null || !working || !improve) return null
    parsed.push({ name, score: sectionScore, working, improve })
  }
  return { overallScore, sections: parsed, topSuggestion, ...(photos && { photos }) }
}

// The optional photos block; dropped (not fatal) when malformed.
function parsePhotos(v: unknown): PhotoFeedback | null {
  if (typeof v !== 'object' || v === null) return null
  const p = v as Record<string, unknown>
  const photoScore = score(p.score)
  const working = text(p.working)
  const improve = text(p.improve)
  if (photoScore === null || !working || !improve) return null
  const suggestions = Array.isArray(p.suggestions)
    ? p.suggestions.map(text).filter((x): x is string => x !== null).slice(0, MAX_PHOTO_SUGGESTIONS)
    : []
  return { score: photoScore, working, improve, suggestions }
}
