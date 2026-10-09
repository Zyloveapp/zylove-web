// Size caps for what goes into an AI prompt from a stored profile (H7,
// fresh-eyes review 2026-10-09). The rules only bound the main fields'
// sizes (firestore.rules profileSizesOk), not what's inside a list, and a
// padded doc (a 1 MB bio, thousands of tags or answers) went into the
// prompt whole. Every piece is cut here first, each person's block has a
// total, and aiCall.ts refuses any prompt over MAX_PROMPT_CHARS.
//
// Generous for real profiles: the editors cap a bio at 300 and an answer at
// 200; no Spark list has 25 options; a profile shows up to 6 prompts.

export const PROMPT_CAPS = {
  text: 500, // a bio
  short: 40, // a name, a style key
  items: 25, // per list
  item: 40, // per list entry
  answers: 10, // prompt answers
  answer: 300, // per answer
  block: 6000, // one person's profile, all told
} as const

// A trimmed string, cut to `max` ('' when not a string).
export function capText(v: unknown, max: number = PROMPT_CAPS.text): string {
  return typeof v === 'string' ? v.trim().slice(0, max).trim() : ''
}

// The strings of a list, trimmed, each cut, duplicates and blanks dropped,
// at most `items` of them.
export function capList(v: unknown, items: number = PROMPT_CAPS.items, chars: number = PROMPT_CAPS.item): string[] {
  if (!Array.isArray(v)) return []
  const out = new Set<string>()
  for (const x of v) {
    if (out.size >= items) break
    const s = capText(x, chars)
    if (s) out.add(s)
  }
  return [...out]
}

// A whole block (one person's profile) cut to `max`, marked when cut.
export function capBlock(text: string, max: number = PROMPT_CAPS.block): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
