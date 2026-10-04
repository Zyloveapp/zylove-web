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

export interface VisibilityOption {
  value: Visibility
  emoji: string
  label: string
  pill: string
  description: string
  dot: string
  // Header pill colours.
  tone: string
}

// Wording and colours per mode. Spark: green / grey / amber. Play: green when
// active, red tints when hidden or on a break.
export function visibilityOptions(mode: Mode): VisibilityOption[] {
  const play = mode === 'play'
  return [
    {
      value: 'active',
      emoji: '🟢',
      label: 'Active',
      pill: '🟢 Active',
      description: play ? "You're visible in Play Explore" : "You're visible in Explore",
      dot: 'bg-emerald-500',
      tone: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400',
    },
    {
      value: 'hidden',
      emoji: '👻',
      label: 'Hidden',
      pill: '👻 Hidden',
      description: play
        ? 'Hidden from Play Explore. Your Flames can still reach you.'
        : 'Hidden from Explore. Your Links can still reach you.',
      dot: play ? 'bg-red-400/70' : 'bg-gray-400',
      tone: play ? 'border-[#E03131]/30 bg-[#E03131]/10 text-red-300' : 'border-white/20 bg-white/10 text-white/70',
    },
    {
      value: 'paused',
      emoji: '☕',
      label: 'On a break',
      pill: '☕ Break',
      description: play ? 'Your Play profile is on a break.' : 'Your Spark profile is on a break.',
      dot: play ? 'bg-[#E03131]' : 'bg-amber-500',
      tone: play ? 'border-[#E03131]/40 bg-[#E03131]/15 text-red-400' : 'border-amber-500/30 bg-amber-500/15 text-amber-400',
    },
  ]
}
