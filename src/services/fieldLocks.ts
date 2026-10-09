import { FirebaseError } from 'firebase/app'
import { deleteField, getDoc, serverTimestamp, Timestamp, type DocumentData } from 'firebase/firestore'
import { matchingDoc } from './privateMatching'
import { privateProfileDoc } from './privateProfile'
import {
  LIMITED_MATCHING_FIELDS,
  LIMITED_PROFILE_FIELDS,
  isUnset,
  lockedMessage,
  lockedUntil,
  needsStamp,
  normaliseValue,
  sameValue,
  type LimitedField,
} from './fieldLimits'

// F-099: the 30-day limit on religion, politics, drinking, attraction,
// dealbreakers and intent (fieldLimits.ts has the rules of it). This side
// reads each field's saved value and last-change stamp, and builds the writes
// a save needs: only fields that really change, lists sorted, and the stamp
// when the change counts. A locked field is refused here with the date it
// unlocks, before anything is written; the rules refuse it anyway.

export type FieldState = { value: unknown; stampMs: number | null }
export type FieldStates = Record<LimitedField, FieldState>
export type LockedField = { field: LimitedField; until: number }
// When each locked field unlocks (ms); unlocked fields are left out.
export type FieldLocks = Partial<Record<LimitedField, number>>

// A refused change, with the plain message ("You can change your religion
// again on November 8."). friendlyError shows it as is.
export class FieldLockedError extends Error {
  readonly locked: LockedField[]
  constructor(locked: LockedField[]) {
    super(lockedMessage(locked))
    this.name = 'FieldLockedError'
    this.locked = locked
  }
}

const millis = (v: unknown): number | null => (v instanceof Timestamp ? v.toMillis() : null)

function statesOf(fields: readonly LimitedField[], d: DocumentData | undefined): Partial<FieldStates> {
  const stamps = (d?.fieldChangedAt ?? {}) as Record<string, unknown>
  return Object.fromEntries(fields.map((f) => [f, { value: d?.[f], stampMs: millis(stamps[f]) }]))
}

// The saved values and stamps (the docs themselves: the rules judge by them).
export async function loadFieldStates(uid: string): Promise<FieldStates> {
  const [m, p] = await Promise.all([getDoc(matchingDoc(uid)), getDoc(privateProfileDoc(uid))])
  return { ...statesOf(LIMITED_MATCHING_FIELDS, m.data()), ...statesOf(LIMITED_PROFILE_FIELDS, p.data()) } as FieldStates
}

export function fieldLocks(states: FieldStates, now = Date.now()): FieldLocks {
  const out: FieldLocks = {}
  for (const [f, s] of Object.entries(states) as [LimitedField, FieldState][]) {
    const until = lockedUntil(s.stampMs, now)
    if (until !== null) out[f] = until
  }
  return out
}

// The locked fields among those `desired` would change.
export function lockedChanges(states: FieldStates, desired: Partial<Record<LimitedField, unknown>>, now = Date.now()): LockedField[] {
  return (Object.entries(desired) as [LimitedField, unknown][])
    .filter(([f, v]) => v !== undefined && !sameValue(states[f].value, v))
    .flatMap(([f]) => {
      const until = lockedUntil(states[f].stampMs, now)
      return until === null ? [] : [{ field: f, until }]
    })
}

// The writes (for set with merge) that move the limited fields in `desired`
// to their new values: unchanged ones are left out; a cleared list is saved
// empty, a cleared value removed; fieldChangedAt.<field> is stamped when the
// change counts. Throws FieldLockedError if one is locked.
export function limitedPatch(states: FieldStates, desired: Partial<Record<LimitedField, unknown>>, now = Date.now()): Record<string, unknown> {
  const locked = lockedChanges(states, desired, now)
  if (locked.length > 0) throw new FieldLockedError(locked)
  const patch: Record<string, unknown> = {}
  const stamps: Record<string, unknown> = {}
  for (const [f, v] of Object.entries(desired) as [LimitedField, unknown][]) {
    if (v === undefined || sameValue(states[f].value, v)) continue
    patch[f] = isUnset(v) ? (Array.isArray(v) ? [] : deleteField()) : normaliseValue(v)
    if (needsStamp(states[f].value, states[f].stampMs)) stamps[f] = serverTimestamp()
  }
  if (Object.keys(stamps).length > 0) patch.fieldChangedAt = stamps
  return patch
}

// Deleting a profile moves the intent to the mode that's left. Never blocked:
// the rules allow 'open' → the remaining mode at any time once the other
// profile is gone (stamped all the same). Anything else that's locked keeps
// the current intent rather than stop the deletion.
export function remainingModeIntent(states: FieldStates, intent: 'spark' | 'play', now = Date.now()): Record<string, unknown> {
  const { value, stampMs } = states.intent
  if (sameValue(value, intent)) return {}
  if (value !== 'open' && lockedUntil(stampMs, now) !== null) return {}
  return { intent, ...(needsStamp(value, stampMs) && { fieldChangedAt: { intent: serverTimestamp() } }) }
}

// A save the rules refused: if it was a locked field (changed elsewhere since
// the page loaded, say), the message with its date; otherwise the error.
export async function explainRefusal(uid: string, desired: Partial<Record<LimitedField, unknown>>, err: unknown): Promise<unknown> {
  if (!(err instanceof FirebaseError) || err.code !== 'permission-denied') return err
  const locked = await loadFieldStates(uid)
    .then((states) => lockedChanges(states, desired))
    .catch(() => [])
  return locked.length > 0 ? new FieldLockedError(locked) : err
}
