import { addDoc, collection, serverTimestamp } from 'firebase/firestore'
import { FirebaseError } from 'firebase/app'
import { db } from './firebase'

// Public (signed-out) form submissions, written straight to Firestore.
// contactMessages is create-only for clients in firestore.rules (no reads).

const EMAIL = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/
export const MAX_SHORT = 100
export const MAX_LONG = 1000

// Normalized email, or null if it isn't one.
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase()
  return EMAIL.test(email) && email.length <= 254 ? email : null
}

export type SubmitResult = 'ok' | 'duplicate-or-denied' | 'failed'

async function submit(write: () => Promise<unknown>): Promise<SubmitResult> {
  try {
    await write()
    return 'ok'
  } catch (err) {
    return err instanceof FirebaseError && err.code === 'permission-denied' ? 'duplicate-or-denied' : 'failed'
  }
}

export interface ContactMessage {
  name: string
  email: string
  topic: string
  message: string
}

export function sendContactMessage(m: ContactMessage): Promise<SubmitResult> {
  return submit(() =>
    addDoc(collection(db, 'contactMessages'), {
      name: m.name.trim().slice(0, MAX_SHORT),
      email: m.email,
      topic: m.topic.slice(0, MAX_SHORT),
      message: m.message.trim().slice(0, MAX_LONG),
      createdAt: serverTimestamp(),
    }),
  )
}
