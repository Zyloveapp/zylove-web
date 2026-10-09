import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

// Public (signed-out) form submissions. The contact form goes through the
// submitContactMessage callable (functions/src/contactMessages.ts), which
// checks the fields and limits how often one address can send;
// contactMessages is server-only in firestore.rules.

const EMAIL = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/
export const MAX_SHORT = 100
export const MAX_LONG = 1000

// Normalized email, or null if it isn't one.
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase()
  return EMAIL.test(email) && email.length <= 254 ? email : null
}

export type SubmitResult = 'ok' | 'failed'

export interface ContactMessage {
  name: string
  email: string
  topic: string
  message: string
}

export async function sendContactMessage(m: ContactMessage): Promise<SubmitResult> {
  try {
    await httpsCallable<ContactMessage, { ok: true }>(functions, 'submitContactMessage')({
      name: m.name.trim().slice(0, MAX_SHORT),
      email: m.email,
      topic: m.topic.slice(0, MAX_SHORT),
      message: m.message.trim().slice(0, MAX_LONG),
    })
    return 'ok'
  } catch {
    return 'failed'
  }
}
