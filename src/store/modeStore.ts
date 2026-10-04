import { create } from 'zustand'

export type Mode = 'spark' | 'play'

interface ModeState {
  mode: Mode
  setMode: (mode: Mode) => void
}

// Kept for the tab's session, so a refresh stays in the same mode (no Spark
// flash, no transition). A new tab starts in Spark — or Play for Play-only
// users (AuthGuard) — and the Play lock decides whether the PIN is needed.
const KEY = 'zylove_mode'

function savedMode(): Mode {
  try {
    return sessionStorage.getItem(KEY) === 'play' ? 'play' : 'spark'
  } catch {
    return 'spark'
  }
}

export const useModeStore = create<ModeState>((set) => ({
  mode: savedMode(),
  setMode: (mode) => {
    try {
      sessionStorage.setItem(KEY, mode)
    } catch {
      // Storage unavailable — the mode just won't survive a refresh.
    }
    set({ mode })
  },
}))
