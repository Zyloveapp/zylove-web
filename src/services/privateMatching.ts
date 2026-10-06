import { doc, getDoc, onSnapshot, type DocumentData, type Unsubscribe, type WriteBatch } from 'firebase/firestore'
import { db } from './firebase'

// Matching preferences live in the owner-only users/{uid}/private/matching
// (Stage 3, F-013): who they want to see and how. Explore and scoring read
// them server-side; nobody else can. Accounts from before the move still
// have copies on the public doc; those count until migrated.

export const MATCHING_KEYS = [
  'attractedTo', 'matchableAs', 'ageMin', 'ageMax', 'radiusMiles', 'drinkingHabit', 'showOrientation',
  'dealbreakers', 'seekingBodyTypes', 'seekingTraits', 'seekingHeightMinCm', 'seekingHeightMaxCm',
] as const
export type Matching = Partial<Record<(typeof MATCHING_KEYS)[number], unknown>>

export const matchingDoc = (uid: string) => doc(db, 'users', uid, 'private', 'matching')

function view(m: DocumentData | undefined, root: DocumentData | undefined): Matching {
  const out: Matching = {}
  for (const k of MATCHING_KEYS) {
    const v = m?.[k] !== undefined ? m[k] : root?.[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

export async function loadMatching(uid: string, root?: DocumentData): Promise<Matching> {
  const [m, r] = await Promise.all([
    getDoc(matchingDoc(uid)).catch(() => null),
    root ? Promise.resolve(root) : getDoc(doc(db, 'users', uid)).then((s) => s.data()).catch(() => undefined),
  ])
  return view(m?.data(), r)
}

// Live: fires once both docs have answered (an unreadable one counts as empty).
export function subscribeMatching(uid: string, onChange: (m: Matching) => void, onError: () => void): Unsubscribe {
  const docs: { m?: DocumentData; root?: DocumentData } = {}
  const answered = new Set<string>()
  const got = (key: 'm' | 'root', data: DocumentData | undefined) => {
    docs[key] = data
    answered.add(key)
    if (answered.size === 2) onChange(view(docs.m, docs.root))
  }
  const offs = [
    onSnapshot(matchingDoc(uid), (s) => got('m', s.data()), () => got('m', undefined)),
    onSnapshot(doc(db, 'users', uid), (s) => got('root', s.data()), onError),
  ]
  return () => offs.forEach((off) => off())
}

// Only the allow-listed keys (the rules check them too); undefined values skipped.
export function matchingPatch(patch: Matching): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([k, v]) => (MATCHING_KEYS as readonly string[]).includes(k) && v !== undefined))
}

export function addMatching(batch: WriteBatch, uid: string, patch: Matching): void {
  const clean = matchingPatch(patch)
  if (Object.keys(clean).length) batch.set(matchingDoc(uid), clean, { merge: true })
}
