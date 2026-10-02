import { addDoc, collection, doc, serverTimestamp, setDoc } from 'firebase/firestore'
import { FirebaseError } from 'firebase/app'
import { db } from './firebase'

// Public (signed-out) form submissions, written straight to Firestore.
// Each collection is create-only for clients in firestore.rules: no reads,
// and an existing doc can't be overwritten.

const EMAIL = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/
export const MAX_SHORT = 100
export const MAX_LONG = 1000

// Normalized email (also the doc id), or null if it isn't one.
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
    // An existing doc (already signed up) is an update, which the rules deny.
    return err instanceof FirebaseError && err.code === 'permission-denied' ? 'duplicate-or-denied' : 'failed'
  }
}

export function joinWaitlist(email: string): Promise<SubmitResult> {
  return submit(() => setDoc(doc(db, 'waitlist', email), { email, source: 'web-join', createdAt: serverTimestamp() }))
}

export interface FoundingApplication {
  name: string
  email: string
  instagram: string
  why: string
}

export function applyFounding(a: FoundingApplication): Promise<SubmitResult> {
  return submit(() =>
    setDoc(doc(db, 'foundingApplications', a.email), {
      name: a.name.trim().slice(0, MAX_SHORT),
      email: a.email,
      instagram: a.instagram.trim().slice(0, MAX_SHORT),
      why: a.why.trim().slice(0, MAX_LONG),
      createdAt: serverTimestamp(),
    }),
  )
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
