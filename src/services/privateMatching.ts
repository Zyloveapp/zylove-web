import { deleteField, doc, getDoc, onSnapshot, type DocumentData, type Unsubscribe, type WriteBatch } from 'firebase/firestore'
import { db } from './firebase'
import type { OnboardingDraft } from '../components/onboarding/types'

// Matching preferences live in the owner-only users/{uid}/private/matching
// (Stage 3, F-013): who they want to see and how. Explore and scoring read
// them server-side; nobody else can. Accounts from before the move still
// have copies on the public doc; those count until migrated.

export const MATCHING_KEYS = [
  'attractedTo', 'matchableAs', 'ageMin', 'ageMax', 'radiusMiles', 'drinkingHabit', 'showOrientation',
  'dealbreakers', 'seekingBodyTypes', 'seekingTraits', 'seekingHeightMinCm', 'seekingHeightMaxCm',
  // F-018: never shown to anyone — matching only.
  'religion', 'politicalView',
  // §4.A2: gender, its self-description and pronouns (gender identity-locked
  // like matchableAs), and how it's shown. Others see only the public
  // genderLine the server builds from these.
  'genderIdentity', 'genderSelfDescribe', 'pronouns', 'genderHidden', 'showGender',
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

// §4.A2: gender, its self-description, pronouns and how it's shown — written
// to the owner-only private/matching, never the public doc (the server builds
// the public genderLine from them). The gender and self-description are
// identity-locked like matchableAs: once locked they're left out, and the
// rules would refuse a change. Pronouns and the display choices stay editable.
export function genderFields(
  d: Pick<OnboardingDraft, 'genderSelfDescribe' | 'pronouns' | 'genderHidden' | 'showGender'>,
  genderIdentity: string,
  identityLocked: boolean,
): Record<string, unknown> {
  const selfDescribe = d.genderSelfDescribe.trim()
  return {
    ...(!identityLocked && {
      genderIdentity,
      genderSelfDescribe: genderIdentity === 'self_describe' && selfDescribe ? selfDescribe : deleteField(),
    }),
    pronouns: d.pronouns.trim() || deleteField(),
    genderHidden: d.genderHidden || deleteField(),
    showGender: d.showGender || deleteField(),
  }
}
