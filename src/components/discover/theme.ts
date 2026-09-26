import type { Mode } from '../../store/modeStore'

// Full literal class strings so Tailwind's scanner picks them up.
export interface DiscoverTheme {
  pill: string
  heading: string
  operateLabel: string
  scoreText: string
  barFill: string
}

const THEMES: Record<Mode, DiscoverTheme> = {
  spark: {
    pill: 'bg-[#1B4FD8]/15 text-[#6B8FFF] border border-[#1B4FD8]/30',
    heading: 'text-[#1B4FD8]/50',
    operateLabel: 'text-[#1B4FD8]/60',
    scoreText: 'text-[#1B4FD8]',
    barFill: 'bg-[#1B4FD8]',
  },
  play: {
    pill: 'bg-[#E03131]/15 text-[#FF6B6B] border border-[#E03131]/30',
    heading: 'text-[#E03131]/50',
    operateLabel: 'text-[#E03131]/60',
    scoreText: 'text-[#E03131]',
    barFill: 'bg-[#E03131]',
  },
}

export function discoverTheme(mode: Mode): DiscoverTheme {
  return THEMES[mode]
}
