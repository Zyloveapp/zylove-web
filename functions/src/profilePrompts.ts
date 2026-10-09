// AI prompts built from stored profiles: conversation starters (both
// people's docs) and the caller's own profile for "Just for you" and the
// Spark review. H7 (fresh-eyes review 2026-10-09): every stored piece is
// capped (promptCaps.ts), and so is each person's block — a padded doc
// went into the prompt whole.

import type { DocumentData } from 'firebase-admin/firestore'
import { PROFILE_DATA_RULE, profileBlock } from './aiOutput'
import { PROMPT_CAPS, capBlock, capList, capText } from './promptCaps'
import { PLAY_PROMPTS, SPARK_PROMPTS, UNIVERSAL_PROMPTS } from './shared/profile'

const STARTER_PROMPT_TEXT = new Map(
  [...UNIVERSAL_PROMPTS, ...SPARK_PROMPTS, ...PLAY_PROMPTS].map((p) => [p.id, p.text]),
)

// H7: every stored piece is capped (promptCaps.ts) — these read the other
// person's doc too.
export function list(v: unknown): string {
  const items = capList(v)
  return items.length > 0 ? items.join(', ') : 'none listed'
}

export function promptSummary(v: unknown): string {
  if (!Array.isArray(v)) return 'none'
  const answered = v
    .filter((a): a is { promptId?: unknown; answer: string } => typeof a?.answer === 'string' && a.answer.trim() !== '')
    .slice(0, PROMPT_CAPS.answers)
    .map((a) => {
      const prompt = typeof a.promptId === 'string' ? STARTER_PROMPT_TEXT.get(a.promptId) : undefined
      return `${prompt ?? 'Prompt'} "${a.answer.trim().slice(0, 200)}"`
    })
  return answered.length > 0 ? answered.join('; ') : 'none'
}

export function personLine(user: DocumentData | undefined): string {
  const name = capText(user?.displayName, PROMPT_CAPS.short) || 'Someone'
  return capBlock(`${name}, interests: ${list(user?.lifestyleTags)}, values: ${list(user?.relationshipValues)}, prompts: ${promptSummary(user?.promptAnswers)}`)
}

export function buildStarterPrompt(me: DocumentData | undefined, them: DocumentData | undefined): string {
  return `Generate 3 short, natural conversation starters for two people who just matched on a dating app.
${profileBlock('person_a', personLine(me))}
${profileBlock('person_b', personLine(them))}
${PROFILE_DATA_RULE}
Rules: under 15 words each, conversational not formal, based on something specific from their profiles, no generic openers like 'hey' or 'how are you'
Return as JSON array of 3 strings.`
}

export function playPersonLine(root: DocumentData | undefined, play: DocumentData | undefined): string {
  const name = [play?.playDisplayName, root?.playDisplayName, play?.displayName].map((n) => capText(n, PROMPT_CAPS.short)).find(Boolean) ?? 'Someone'
  const bio = capText(play?.playBio, 200)
  const spice = capText(play?.spiceLevel, PROMPT_CAPS.short) || 'unknown'
  return capBlock(`${name}, Play bio: ${bio ? `"${bio}"` : 'none'}, spice level: ${spice}, into: ${list(play?.playInterestTags)}, prompts: ${promptSummary(play?.promptAnswers)}`)
}

export function buildPlayStarterPrompt(lines: [string, string]): string {
  return `Generate 3 short, natural opening messages for two adults who just matched in the casual, flirty "Play" side of a dating app.
${profileBlock('person_a', lines[0])}
${profileBlock('person_b', lines[1])}
${PROFILE_DATA_RULE}
Rules: under 15 words each, playful and confident, flirty but tasteful and respectful — nothing explicit or graphic, consent-minded, based on something specific from their Play profiles, no generic openers like 'hey' or 'how are you'
Return as JSON array of 3 strings.`
}

export function humanizeKey(key: string): string {
  return key.replace(/_/g, ' ')
}

export function humanList(v: unknown): string {
  return capList(v).map(humanizeKey).join(', ') || 'none listed'
}

export interface OwnAnswer {
  question: string
  answer: string
}

// Prompt answers from wherever this profile keeps them: sparkProfile/data's
// sparkPromptAnswers map (web) or promptAnswers array, else the root doc.
export function ownPromptAnswers(root: DocumentData, spark: DocumentData): OwnAnswer[] {
  const fromList = (v: unknown) =>
    Array.isArray(v)
      ? v
          .filter((a) => typeof a?.promptId === 'string' && typeof a?.answer === 'string' && a.answer.trim())
          .map((a) => ({ promptId: a.promptId as string, answer: (a.answer as string).trim() }))
      : []
  const map: unknown = spark.sparkPromptAnswers
  const fromMap =
    typeof map === 'object' && map !== null && !Array.isArray(map)
      ? Object.entries(map)
          .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '')
          .map(([promptId, answer]) => ({ promptId, answer: answer.trim() }))
      : []
  const raw = fromMap.length > 0 ? fromMap : fromList(spark.promptAnswers).length > 0 ? fromList(spark.promptAnswers) : fromList(root.promptAnswers)
  const dynamic = capText(typeof spark.dynamicPrompt === 'string' ? spark.dynamicPrompt : root.dynamicPrompt, PROMPT_CAPS.answer)
  // H7: at most PROMPT_CAPS.answers, each capped.
  return raw.slice(0, PROMPT_CAPS.answers).map((a) => ({
    question: a.promptId === 'dynamic' && dynamic ? dynamic : (STARTER_PROMPT_TEXT.get(a.promptId) ?? humanizeKey(capText(a.promptId, PROMPT_CAPS.short))),
    answer: capText(a.answer, PROMPT_CAPS.answer),
  }))
}

export function ownBio(root: DocumentData, spark: DocumentData): string {
  // Mobile's editor saves the bio only to sparkProfile/data.
  const bio = typeof spark.bio === 'string' && spark.bio.trim() ? spark.bio : root.bio
  return capText(bio)
}

// The fields a match actually sees — never birthday, contact or location data.
export function profileForReview(root: DocumentData, spark: DocumentData): string {
  const photoCount = Array.isArray(root.photoURLs) ? root.photoURLs.length : 0
  const answers = ownPromptAnswers(root, spark)
  // §4.A2: what a match sees of gender and pronouns is the server-built line.
  const genderLine = capText(root.genderLine, 200)
  const style = (v: unknown) => humanizeKey(capText(v, PROMPT_CAPS.short))
  // H7: each piece capped (promptCaps.ts), and the whole block.
  return capBlock([
    `Name: ${capText(root.displayName, PROMPT_CAPS.short) || 'Unknown'}`,
    typeof root.age === 'number' ? `Age: ${root.age}` : '',
    genderLine ? `Gender and pronouns shown: ${genderLine}` : '',
    `Photos: ${photoCount}`,
    `Bio: ${ownBio(root, spark) || 'none'}`,
    `Open to: ${humanList(root.openTo)}`,
    `Personality: ${humanList(root.personalityTraits)}`,
    `Values: ${humanList(root.relationshipValues)}`,
    `Lifestyle: ${humanList(root.lifestyleTags)}`,
    `Habits: ${humanList(root.habitTags)}`,
    `Weekends: ${humanList(root.weekendVibes)}`,
    `Love languages (gives): ${humanList(root.loveLangGive)}; (receives): ${humanList(root.loveLangReceive)}`,
    style(root.conflictStyle) ? `Conflict style: ${style(root.conflictStyle)}` : '',
    style(root.togethernessStyle) ? `Together time: ${style(root.togethernessStyle)}` : '',
    style(root.stressResponse) ? `Under stress: ${style(root.stressResponse)}` : '',
    answers.length > 0 ? `Prompts:\n${answers.map((a) => `- ${a.question} "${a.answer.slice(0, 200)}"`).join('\n')}` : 'Prompts: none',
  ]
    .filter(Boolean)
    .join('\n'))
}

// "✦ Just for you": one new prompt question from the caller's own profile.
export function buildProfileQuestionPrompt(root: DocumentData, spark: DocumentData): string {
  const answered = ownPromptAnswers(root, spark).map((a) => a.question)
  return `Based on this person's dating profile, generate ONE unique, thoughtful question they could answer to help potential matches understand them better. The question should be specific to their actual interests, values and personality — not generic. It should be something that reveals character and sparks conversation.

Profile: ${capBlock(`Name: ${capText(root.displayName, PROMPT_CAPS.short) || 'Unknown'}, Personality: ${humanList(root.personalityTraits)}, Values: ${humanList(root.relationshipValues)}, Lifestyle: ${humanList(root.lifestyleTags)}, Bio: ${ownBio(root, spark) || 'none'}, Prompts already answered: ${answered.join(' | ') || 'none'}`)}

Rules: under 12 words, conversational, specific to this person, not a question they already answered, no yes/no questions.
Return only the question text, nothing else.`
}
