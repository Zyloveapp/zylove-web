import { create } from 'zustand'

export type Mode = 'spark' | 'play'

interface ModeState {
  mode: Mode
  setMode: (mode: Mode) => void
}

export const useModeStore = create<ModeState>((set) => ({
  mode: 'spark',
  setMode: (mode) => set({ mode }),
}))
