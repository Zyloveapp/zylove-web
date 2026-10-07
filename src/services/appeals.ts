import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

// T&S Phase 4 — appealing a suspension (functions/src/appeals.ts). A
// suspended account's sign-in is refused, after the phone was verified, with
//   "ZYLOVE_SUSPENDED:<token|->:<none|pending|upheld|overturned>:<review|timed>:<until ms>"
// somewhere in the error; the token lets them file one appeal.

export const APPEAL_NOTE_MAX = 1000

export interface Suspension {
  token: string | null
  appeal: 'none' | 'pending' | 'upheld' | 'overturned'
  pendingReview: boolean
  until: number | null
}

export function parseSuspension(err: unknown): Suspension | null {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const m = text.match(/ZYLOVE_SUSPENDED:([A-Za-z0-9_-]+):(none|pending|upheld|overturned):(review|timed):(\d+)/)
  if (!m) return null
  return { token: m[1] === '-' ? null : m[1], appeal: m[2] as Suspension['appeal'], pendingReview: m[3] === 'review', until: Number(m[4]) || null }
}

export async function submitAppeal(token: string, note: string): Promise<void> {
  await httpsCallable(functions, 'submitAppeal')({ token, note })
}
