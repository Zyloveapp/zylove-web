import { CONTACT_MASK, maskContact } from './contactDetect'

// F-112 (M1): contact details stay out of profile text (bio, prompt answers)
// — they're shared through Share contact in a chat. The same patterns as
// functions/src/profileText.ts, which masks anything that gets past this.

const URL_OR_DOMAIN = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|me|app|ly|gg|tv|us|info|biz|link|xyz|site|online|page|bio|to|cc|ai|dev)\b/gi
const HANDLE = /(^|[^\w])@[a-z0-9_.]{2,}/gi
const EMAIL = /[a-z0-9._%+-]+\s*@\s*[a-z0-9.-]+\.[a-z]{2,}/gi
const DIGIT_RUN = /\d(?:[\s().+-]*\d){6,}/g

export function maskProfileText(text: string): string {
  let out = text.replace(EMAIL, CONTACT_MASK).replace(URL_OR_DOMAIN, CONTACT_MASK)
  out = out.replace(HANDLE, (_m, pre: string) => `${pre}${CONTACT_MASK}`).replace(DIGIT_RUN, CONTACT_MASK)
  return maskContact(out)
}

export const hasContactDetails = (text: string): boolean => maskProfileText(text) !== text

export class ProfileTextError extends Error {
  constructor() {
    super('Keep links, handles, emails and phone numbers out of your profile — share them in a chat with Share contact.')
    this.name = 'ProfileTextError'
  }
}

// Throws ProfileTextError if any of `texts` has contact details.
export function checkProfileText(...texts: (string | null | undefined)[]): void {
  if (texts.some((t) => typeof t === 'string' && hasContactDetails(t))) throw new ProfileTextError()
}
