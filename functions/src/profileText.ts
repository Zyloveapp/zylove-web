// F-112 (M1): contact details in profile text. Bios and prompt answers are
// shown to everyone who sees the profile, and the only contact filtering was
// in chat (on the recipient's device) and on AI output — anyone could type
// "add me on telegram @x / 512 555 …" into their own bio.
//
// The app's editors refuse such text before saving (src/services/profileText.ts,
// the same patterns). These triggers are the server's backstop for writes
// that skip the app: links, domains, @handles, emails and phone numbers in
// the public text fields are replaced with "•••" in place. The Play profile's
// public mirror (playProfiles/{playId}) copies the masked text.

import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import type { DocumentData } from 'firebase-admin/firestore'
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

export const needsMask = (text: unknown): boolean => typeof text === 'string' && maskProfileText(text) !== text

// The masked values to write back for a profile doc's public text fields,
// or null when nothing needs masking. Prompt answers come as a list of
// { promptId, answer } and/or a map promptId → answer.
export function maskedFields(doc: DocumentData | undefined, textKeys: string[], listKeys: string[], mapKeys: string[]): DocumentData | null {
  if (!doc) return null
  const out: DocumentData = {}
  for (const k of textKeys) if (needsMask(doc[k])) out[k] = maskProfileText(doc[k] as string)
  for (const k of listKeys) {
    const list = doc[k]
    if (!Array.isArray(list)) continue
    const masked = list.map((p: unknown) =>
      typeof p === 'object' && p !== null && typeof (p as DocumentData).answer === 'string'
        ? { ...(p as DocumentData), answer: maskProfileText((p as DocumentData).answer) }
        : p,
    )
    if (JSON.stringify(masked) !== JSON.stringify(list)) out[k] = masked
  }
  for (const k of mapKeys) {
    const m = doc[k]
    if (typeof m !== 'object' || m === null || Array.isArray(m)) continue
    const masked = Object.fromEntries(Object.entries(m).map(([id, a]) => [id, typeof a === 'string' ? maskProfileText(a) : a]))
    if (JSON.stringify(masked) !== JSON.stringify(m)) out[k] = masked
  }
  return Object.keys(out).length ? out : null
}

const ROOT_TEXT = ['bio', 'dynamicPrompt']
const PLAY_TEXT = ['playBio', 'bio', 'dynamicPrompt']

export const maskProfileTextOnUser = onDocumentWritten({ document: 'users/{uid}', memory: '256MiB' }, async (event) => {
  const after = event.data?.after
  if (!after?.exists) return
  const fields = maskedFields(after.data(), ROOT_TEXT, ['promptAnswers'], [])
  if (!fields) return
  logger.info('maskProfileTextOnUser: masked', { fields: Object.keys(fields) })
  await after.ref.update(fields)
})

export const maskProfileTextOnPlayProfile = onDocumentWritten(
  { document: 'users/{uid}/playProfile/data', memory: '256MiB' },
  async (event) => {
    const after = event.data?.after
    if (!after?.exists) return
    const fields = maskedFields(after.data(), PLAY_TEXT, ['promptAnswers'], ['playPromptAnswers'])
    if (!fields) return
    logger.info('maskProfileTextOnPlayProfile: masked', { fields: Object.keys(fields) })
    await after.ref.update(fields)
  },
)
