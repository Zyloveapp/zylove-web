import type { Mode } from '../../store/modeStore'

// Mode color is reserved for a few accents: the score, active bars, the
// primary action and the mode badge. Everything else stays neutral.
// Full literal class strings so Tailwind's scanner picks them up.
export interface DiscoverTheme {
  scoreText: string
  barFill: string
}

const THEMES: Record<Mode, DiscoverTheme> = {
  spark: { scoreText: 'text-[#1B4FD8]', barFill: 'bg-[#1B4FD8]' },
  play: { scoreText: 'text-[#E03131]', barFill: 'bg-[#E03131]' },
}

export function discoverTheme(mode: Mode): DiscoverTheme {
  return THEMES[mode]
}
