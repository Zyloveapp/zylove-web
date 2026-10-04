// "How's my Play profile?" — builds the review prompt from the saved Play
// profile (users/{uid}/playProfile/data). Parsing and labels are shared with
// the Play bio prompt so both read the profile the same way.

import { PLAY_NON_NEGOTIABLE_LABELS, PLAY_PROMPT_BANK, PLAY_TAG_LABELS, SPICE_META, type PlayInterestTag } from './shared/dualProfile'
import { parsePlayBioRequest } from './playBioPrompt'
import { aboutLine, qaBlocks } from './playGoDeeperPrompt'

const MAX_BIO = 500

const tagLabels = (list: PlayInterestTag[]) => list.map((t) => PLAY_TAG_LABELS[t].label).join(', ')

export function buildPlayReviewPrompt(play: Record<string, unknown>): string {
  const tags = Array.isArray(play.playInterestTags) ? play.playInterestTags : []
  const r = parsePlayBioRequest({
    ...play,
    arrangement: tags,
    acts: tags,
    dynamic: tags,
    vibe: tags,
    place: tags,
    nonNegotiables: play.playNonNegotiables,
    promptAnswers: play.playPromptAnswers ?? play.promptAnswers,
  })
  const spice = r.spiceLevel ? SPICE_META[r.spiceLevel] : null
  const bio = typeof play.playBio === 'string' ? play.playBio.trim().slice(0, MAX_BIO) : ''
  const prompts = r.promptAnswers
    .map((pa) => `Q: ${PLAY_PROMPT_BANK.find((p) => p.id === pa.promptId)?.text ?? pa.promptId}\nA: ${pa.answer}`)
    .join('\n\n')
  const none = 'none given'

  return `You are reviewing an adult dating profile on Zylove Play — an adult platform where people are honest about what they want.

Review this profile and give honest, constructive feedback. Be direct but kind.

── THEIR PROFILE ──
Spice level: ${spice ? `${spice.label} — ${spice.description}` : none}
Here for: ${tagLabels(r.arrangement) || none}
Their dynamic: ${tagLabels(r.dynamic) || none}
Their vibe: ${tagLabels(r.vibe) || none}
Non-negotiables: ${r.nonNegotiables.map((k) => PLAY_NON_NEGOTIABLE_LABELS[k]).join(', ') || none}
About them physically: ${aboutLine(r.about) || none}
Their type: ${r.about.typePreferences.join(', ') || none}
Bio: ${bio || none}
Prompts:
${prompts || none}
Go Deeper:
${qaBlocks(r.goDeeper) || none}

── REVIEW GUIDELINES ──
Give feedback in these areas:

1. CLARITY — Are they clear about what they want? Will the right person know if they're a match?
2. CONSISTENCY — Do their selections and written answers align? (e.g. says Dom but writes passive prompts)
3. TONE — Does their bio/prompts match their spice level and vibe selections?
4. APPEAL — Will this attract the right person? What's working well?
5. ONE THING TO IMPROVE — The single most impactful change they could make

── RULES ──
- Be honest, not flattering
- Be specific — reference their actual selections and answers
- Keep it under 300 words total
- Use short sections with clear headers
- Adult but professional tone — this is coaching, not commentary
- Never be judgmental about their choices — only help them present those choices better
- End with one specific actionable suggestion
- Return ONLY the review, nothing else`
}
