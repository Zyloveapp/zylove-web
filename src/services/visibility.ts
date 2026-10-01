import { doc, onSnapshot, type Unsubscribe } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'
import type { Mode } from '../store/modeStore'

// Per-mode profile visibility, same values as mobile's pauseControl.ts:
//   active — visible in discovery
//   hidden — out of discovery; matches can still reach you
//   paused — "on a break"; out of discovery, matches see a ☕ note
export type Visibility = 'active' | 'hidden' | 'paused'

export interface VisibilityState {
  spark: Visibility
  play: Visibility
  // The modes this user has a profile for (from users/{uid}.intent).
  modes: Mode[]
}

function toVisibility(v: unknown): Visibility {
  // Missing means active — older and mobile-created profiles may lack the field.
  return v === 'hidden' || v === 'paused' ? v : 'active'
}

export function subscribeVisibility(
  uid: string,
  onChange: (state: VisibilityState) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      const data = snap.data() ?? {}
      const modes: Mode[] = data.intent === 'open' ? ['spark', 'play'] : data.intent === 'play' ? ['play'] : ['spark']
      onChange({ spark: toVisibility(data.sparkVisibility), play: toVisibility(data.playVisibility), modes })
    },
    onError,
  )
}

// Fully on a break when every mode the user has is paused — mobile's rule.
// Hidden never locks the app: hidden users are still meant to chat.
export function isOnBreak(state: VisibilityState): boolean {
  return state.modes.every((m) => state[m] === 'paused')
}

export async function setVisibility(mode: Mode, visibility: Visibility): Promise<void> {
  await httpsCallable<{ mode: Mode; visibility: Visibility }, { success: true }>(
    functions,
    'setVisibility',
  )({ mode, visibility })
}
