// "How's my Play profile?" — builds the review prompt from the saved Play
// profile (users/{uid}/playProfile/data). Parsing and labels are shared with
// the Play bio prompt so both read the profile the same way.

import { PLAY_NON_NEGOTIABLE_LABELS, PLAY_PROMPT_BANK, PLAY_TAG_LABELS, SPICE_META, type PlayInterestTag } from './shared/dualProfile'
import { parsePlayBioRequest } from './playBioPrompt'
import { aboutLine, qaBlocks } from './playGoDeeperPrompt'
import { PLAY_REVIEW_SECTIONS, scorecardInstructions } from './profileScorecard'

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

IMPORTANT CONTEXT FOR PLAY ARRANGEMENT TAGS:
In Play mode, arrangement tags are not mutually exclusive and combinations are intentional. Common valid combinations:
- Situationship + Open to more = casual but not closed off — intentional and clear, NOT ambiguous
- FWB + Regular thing = ongoing arrangement preference — consistent
- No strings + Discreet = clear and compatible
- Multiple arrangement tags signal flexibility, not confusion

Only flag arrangement combinations as unclear if they are genuinely contradictory:
- One & done + Regular thing = actually contradicts
- No emotional attachment + Open to more = actually contradicts

Never flag flexibility as ambiguity in a Play context. Flexibility is a feature.

── REVIEW GUIDELINES ──
Score and review these four sections:

- Clarity — Are they clear about what they want? Will the right person know if they're a match?
- Consistency — Do their selections and written answers align? (e.g. says Dom but writes passive prompts)
- Tone — Does their bio/prompts match their spice level and vibe selections?
- Appeal — Will this attract the right person? What's working well?

Then give the single most impactful change they could make as the top suggestion.

── RULES ──
- Be honest, not flattering — scores should be earned
- Be specific — reference their actual selections and answers
- Adult but professional tone — this is coaching, not commentary
- Never be judgmental about their choices — only help them present those choices better

${scorecardInstructions(PLAY_REVIEW_SECTIONS)}`
}
