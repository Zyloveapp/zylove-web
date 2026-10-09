import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

// The /contact inbox (functions/src/contactMessages.ts). contactMessages is
// server-only; every call checks the admin claim and is audited.

export type ContactFilter = 'unhandled' | 'handled' | 'all'

export interface ContactRow {
  id: string
  name: string
  email: string
  topic: string
  message: string
  createdAt: number | null
  handled: boolean
  handledAt: number | null
  // The sender's account when they were signed in.
  uid: string | null
}

// Newest first; `after` (the last id shown) loads the next page.
export async function listContactMessages(filter: ContactFilter, after?: string): Promise<{ messages: ContactRow[]; more: boolean }> {
  const { data } = await httpsCallable<{ filter: ContactFilter; after?: string }, { messages: ContactRow[]; more: boolean }>(
    functions,
    'adminListContactMessages',
  )({ filter, after })
  return data
}

export async function setContactHandled(id: string, handled: boolean): Promise<void> {
  await httpsCallable<{ id: string; handled: boolean }, { ok: true }>(functions, 'adminSetContactHandled')({ id, handled })
}

export async function deleteContactMessage(id: string): Promise<void> {
  await httpsCallable<{ id: string }, { ok: true }>(functions, 'adminDeleteContactMessage')({ id })
}
