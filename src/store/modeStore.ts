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

// Accent classes per mode — cobalt for Spark, red for Play. Literal strings so
// Tailwind sees them.
export const MODE_ACCENT = {
  spark: { text: 'text-[#7C9BFF]', bg: 'bg-[#1B4FD8]', softBg: 'bg-[#1B4FD8]/20', cssVar: '#1B4FD8' },
  play: { text: 'text-[#E03131]', bg: 'bg-[#E03131]', softBg: 'bg-[#E03131]/20', cssVar: '#E03131' },
} as const

// "← Back" links: cobalt in Spark, red in Play.
export function useBackLinkClass(): string {
  return MODE_ACCENT[useModeStore((s) => s.mode)].text
}
