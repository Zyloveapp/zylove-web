import { collection, doc, getDoc, getDocs, limit, query, where } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { db, functions } from './firebase'
import { genderToAttractedToCategory } from '../utils/genderUtils'
import type { DatingProfile } from '../types/profile'
import type { Mode } from '../store/modeStore'

const CANDIDATE_LIMIT = 50

// Firestore docs are written by several clients over time, so every field is
// treated as possibly missing. attractedTo was a single string on older docs.
export type DiscoverProfile = Partial<Omit<DatingProfile, 'attractedTo'>> & {
  uid: string
  attractedTo?: string[] | string
  sparkVisibility?: string
  playVisibility?: string
}

// ─── Swiped list (per user + mode, this browser only) ───────────────────────

function swipedKey(uid: string, mode: Mode): string {
  return `zylove_swiped_${uid}_${mode}`
}

export function loadSwiped(uid: string, mode: Mode): Set<string> {
  try {
    const raw = localStorage.getItem(swipedKey(uid, mode))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function markSwiped(uid: string, mode: Mode, targetUid: string): void {
  try {
    const list = [...loadSwiped(uid, mode)]
    if (!list.includes(targetUid)) list.push(targetUid)
    // Cap so the key can't grow without bound (mobile keeps the last 500).
    localStorage.setItem(swipedKey(uid, mode), JSON.stringify(list.slice(-500)))
  } catch {
    // Storage unavailable (private mode etc.) — the card still advances.
  }
}

// ─── Filtering ───────────────────────────────────────────────────────────────

function asList(v: string[] | string | undefined): string[] {
  if (Array.isArray(v)) return v
  return v ? [v] : []
}

// Age from birthday when the stored age is missing or 0 (mirrors mobile).
export function displayAge(p: DiscoverProfile): number | null {
  if (p.age) return p.age
  if (!p.birthday) return null
  const b = new Date(`${p.birthday}T00:00:00`)
  if (Number.isNaN(b.getTime())) return null
  const now = new Date()
  let age = now.getFullYear() - b.getFullYear()
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age--
  return age
}

// Bilateral attraction: each side's attractedTo must include the other's
// gender category (off-map identities use matchableAs).
function mutuallyAttracted(me: DiscoverProfile, them: DiscoverProfile): boolean {
  const meAs = genderToAttractedToCategory(me.genderIdentity ?? '', me.matchableAs)
  const themAs = genderToAttractedToCategory(them.genderIdentity ?? '', them.matchableAs)
  const theyWantMe = asList(them.attractedTo)
  const iWantThem = asList(me.attractedTo)
  return (
    (theyWantMe.includes('everyone') || theyWantMe.some((a) => meAs.includes(a))) &&
    (iWantThem.includes('everyone') || iWantThem.some((a) => themAs.includes(a)))
  )
}

function intentMatchesMode(p: DiscoverProfile, mode: Mode): boolean {
  return p.intent === mode || p.intent === 'open'
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export async function fetchCandidates(uid: string, mode: Mode): Promise<DiscoverProfile[]> {
  const meSnap = await getDoc(doc(db, 'users', uid))
  if (!meSnap.exists()) return []
  const me = { ...(meSnap.data() as DiscoverProfile), uid }

  const snap = await getDocs(
    query(collection(db, 'users'), where('isSuspended', '==', false), limit(CANDIDATE_LIMIT)),
  )
  const swiped = loadSwiped(uid, mode)
  const visibilityField = mode === 'play' ? 'playVisibility' : 'sparkVisibility'

  const candidates = snap.docs
    .map((d) => ({ ...(d.data() as DiscoverProfile), uid: d.id }))
    .filter((p) => {
      if (p.uid === uid || swiped.has(p.uid)) return false
      if (!p.photoURLs?.length) return false
      if (!intentMatchesMode(p, mode)) return false
      if (p[visibilityField] === 'paused' || p[visibilityField] === 'hidden') return false
      const age = displayAge(p)
      if (age !== null && me.ageMin && me.ageMax && (age < me.ageMin || age > me.ageMax)) return false
      return mutuallyAttracted(me, p)
    })

  // Everyone left has photos, so "photos first" is already satisfied.
  return shuffle(candidates)
}

// ─── Actions (deployed Callables) ────────────────────────────────────────────

interface RecordSwipeRequest {
  targetUid: string
  action: 'pass'
  mode: Mode
}

interface OnLikeRequest {
  likedUserId: string
  mode: Mode
}

export interface OnLikeResponse {
  matched: boolean
  pairId: string
  matchId: string | null
}

// Safety net for profiles saved without trust/safety defaults (e.g. the
// post-onboarding initUserDefaults call failed). Idempotent server-side.
// Fire-and-forget: never blocks or fails the Discover load.
export function ensureUserDefaults(): void {
  httpsCallable(functions, 'initUserDefaults')({}).catch(() => {})
}

export async function passProfile(uid: string, mode: Mode, targetUid: string): Promise<void> {
  await httpsCallable<RecordSwipeRequest, { success: boolean }>(functions, 'recordSwipe')({
    targetUid,
    action: 'pass',
    mode,
  })
  markSwiped(uid, mode, targetUid)
}

export async function likeProfile(uid: string, mode: Mode, targetUid: string): Promise<OnLikeResponse> {
  const { data } = await httpsCallable<OnLikeRequest, OnLikeResponse>(functions, 'onLike')({
    likedUserId: targetUid,
    mode,
  })
  markSwiped(uid, mode, targetUid)
  return data
}

export function actionErrorMessage(err: unknown): string {
  if (err instanceof FirebaseError) {
    if (err.code === 'functions/permission-denied') return 'Your account can’t do that right now.'
    if (err.code === 'functions/unauthenticated') return 'Your session expired — sign in again.'
    return `Something went wrong (${err.code}). Try again.`
  }
  return 'Something went wrong. Check your connection and try again.'
}
