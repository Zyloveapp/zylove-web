import { doc, getDoc, onSnapshot, setDoc, type DocumentData, type Unsubscribe } from 'firebase/firestore'
import { db } from './firebase'

// Profile metadata that would reveal Play use lives in the owner-only
// users/{uid}/private/profile (Stage 2), never on the public doc:
//
//   intent             'spark' | 'play' | 'open'
//   onboardingPath     'spark' | 'play' | 'both'
//   mode               'spark' | 'play' (the mode last used)
//   intentionAnswers   the intention step's answers
//
// Accounts from before the move still have copies on the public doc; those
// count until migrated.

const KEYS = ['intent', 'onboardingPath', 'mode', 'intentionAnswers'] as const
export type PrivateProfile = Partial<Record<(typeof KEYS)[number], unknown>>

export const privateProfileDoc = (uid: string) => doc(db, 'users', uid, 'private', 'profile')

function view(p: DocumentData | undefined, root: DocumentData | undefined): PrivateProfile {
  const out: PrivateProfile = {}
  for (const k of KEYS) out[k] = p?.[k] !== undefined ? p[k] : root?.[k]
  return out
}

export async function loadPrivateProfile(uid: string, root?: DocumentData): Promise<PrivateProfile> {
  const [p, r] = await Promise.all([
    getDoc(privateProfileDoc(uid)).catch(() => null),
    root ? Promise.resolve(root) : getDoc(doc(db, 'users', uid)).then((s) => s.data()).catch(() => undefined),
  ])
  return view(p?.data(), r)
}

// Live view: fires once both docs have answered (an unreadable one counts as empty).
export function subscribePrivateProfile(uid: string, onChange: (p: PrivateProfile) => void): Unsubscribe {
  const docs: { p?: DocumentData; root?: DocumentData } = {}
  const answered = new Set<'p' | 'root'>()
  const got = (key: 'p' | 'root', data: DocumentData | undefined) => {
    docs[key] = data
    answered.add(key)
    if (answered.size === 2) onChange(view(docs.p, docs.root))
  }
  const offs = [
    onSnapshot(privateProfileDoc(uid), (s) => got('p', s.data()), () => got('p', undefined)),
    onSnapshot(doc(db, 'users', uid), (s) => got('root', s.data()), () => got('root', undefined)),
  ]
  return () => offs.forEach((off) => off())
}

// Merges `patch` into private/profile (allow-listed keys only — the rules
// check them too).
export async function savePrivateProfile(uid: string, patch: PrivateProfile): Promise<void> {
  const clean = Object.fromEntries(Object.entries(patch).filter(([k, v]) => (KEYS as readonly string[]).includes(k) && v !== undefined))
  await setDoc(privateProfileDoc(uid), clean, { merge: true })
}
