// F-112 (M1): contact details in profile text. Bios and prompt answers are
// shown to everyone who sees the profile, and the only contact filtering was
// in chat (on the recipient's device) and on AI output — anyone could type
// "add me on telegram @x / 512 555 …" into their own bio.
//
// The app's editors refuse such text before saving (src/services/profileText.ts,
// the same patterns). maskProfileDoc is the server's backstop for writes
// that skip the app: links, domains, @handles, emails and phone numbers in
// the public text fields are replaced with "•••" in place. The Play profile's
// public mirror (playProfiles/{playId}) copies the masked text.

import { logger } from 'firebase-functions'
import type { DocumentData, DocumentReference } from 'firebase-admin/firestore'
import { CONTACT_MASK, maskContact } from './shared/contactDetect'

const URL_OR_DOMAIN = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|me|app|ly|gg|tv|us|info|biz|link|xyz|site|online|page|bio|to|cc|ai|dev)\b/gi
const HANDLE = /(^|[^\w])@[a-z0-9_.]{2,}/gi
const EMAIL = /[a-z0-9._%+-]+\s*@\s*[a-z0-9.-]+\.[a-z]{2,}/gi
const DIGIT_RUN = /\d(?:[\s().+-]*\d){6,}/g

// The text with links, domains, handles, emails and phone numbers masked.
// Idempotent: masking masked text changes nothing.
export function maskProfileText(text: string): string {
  let out = text.replace(EMAIL, CONTACT_MASK).replace(URL_OR_DOMAIN, CONTACT_MASK)
  out = out.replace(HANDLE, (m, pre: string) => `${pre}${CONTACT_MASK}`).replace(DIGIT_RUN, CONTACT_MASK)
  return maskContact(out)
}

// Longest text masked as is. The app writes far less (bio 500, answers 200);
// longer text — written around the app — is cut to this first, which keeps
// the masking fast (the patterns grow faster than the length: 100,000
// characters took ~20 s) and can't hide contact details past the limit.
export const MAX_PROFILE_TEXT = 2000

const bounded = (text: string): string => maskProfileText(text.length > MAX_PROFILE_TEXT ? text.slice(0, MAX_PROFILE_TEXT) : text)

export const needsMask = (text: unknown): boolean => typeof text === 'string' && bounded(text) !== text

// The masked values to write back for a profile doc's public text fields,
// or null when nothing needs masking. Prompt answers come as a list of
// { promptId, answer } and/or a map promptId → answer.
export function maskedFields(doc: DocumentData | undefined, textKeys: string[], listKeys: string[], mapKeys: string[]): DocumentData | null {
  if (!doc) return null
  const out: DocumentData = {}
  for (const k of textKeys) if (needsMask(doc[k])) out[k] = bounded(doc[k] as string)
  for (const k of listKeys) {
    const list = doc[k]
    if (!Array.isArray(list)) continue
    const masked = list.map((p: unknown) =>
      typeof p === 'object' && p !== null && typeof (p as DocumentData).answer === 'string'
        ? { ...(p as DocumentData), answer: bounded((p as DocumentData).answer) }
        : p,
    )
    if (JSON.stringify(masked) !== JSON.stringify(list)) out[k] = masked
  }
  for (const k of mapKeys) {
    const m = doc[k]
    if (typeof m !== 'object' || m === null || Array.isArray(m)) continue
    const masked = Object.fromEntries(Object.entries(m).map(([id, a]) => [id, typeof a === 'string' ? bounded(a) : a]))
    if (JSON.stringify(masked) !== JSON.stringify(m)) out[k] = masked
  }
  return Object.keys(out).length ? out : null
}

const ROOT_TEXT = ['bio', 'dynamicPrompt']
const PLAY_TEXT = ['playBio', 'bio', 'dynamicPrompt']

// Masks a written profile doc in place, when it needs it. Run from the
// existing triggers on these docs (identityGuardOnUser, playProfileOnWrite)
// rather than triggers of its own — one more function on every user-doc write
// was measurable. Returns whether it wrote.
export async function maskProfileDoc(
  ref: DocumentReference,
  data: DocumentData | undefined,
  kind: 'root' | 'play',
): Promise<boolean> {
  const fields = kind === 'root'
    ? maskedFields(data, ROOT_TEXT, ['promptAnswers'], [])
    : maskedFields(data, PLAY_TEXT, ['promptAnswers'], ['playPromptAnswers'])
  if (!fields) return false
  logger.info('maskProfileDoc: masked', { kind, fields: Object.keys(fields) })
  await ref.update(fields)
  return true
}
