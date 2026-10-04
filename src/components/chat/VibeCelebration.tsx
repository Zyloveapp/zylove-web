import { useMemo, type CSSProperties } from 'react'

export const CELEBRATION_MS = 8000

interface Particle {
  left: number // %
  size: number // px
  delay: number // s
  duration: number // s
  drift: number // px
  spin: number // deg
  glyph: string
  color: string
}

const SPARK_COLORS = ['#1B4FD8', '#6B8FFF', '#B4C6FF', '#FFFFFF']
const FLAME_COLORS = ['#E03131', '#FF6B35', '#FFA94D', '#FFD43B']

const rand = (min: number, max: number) => min + Math.random() * (max - min)
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]

// Particles spawn across the first ~5s so the effect keeps rising for the
// full 8s before the layer fades.
function particles(play: boolean): Particle[] {
  return Array.from({ length: play ? 46 : 30 }, () =>
    play
      ? {
          left: rand(0, 100),
          size: rand(18, 40),
          delay: rand(0, 5),
          duration: rand(2.2, 3.6),
          drift: rand(-40, 40),
          spin: rand(-20, 20),
          glyph: Math.random() < 0.55 ? '🔥' : '●',
          color: pick(FLAME_COLORS),
        }
      : {
          left: rand(0, 100),
          size: rand(10, 24),
          delay: rand(0, 5),
          duration: rand(3.5, 5.5),
          drift: rand(-30, 30),
          spin: rand(-120, 120),
          glyph: Math.random() < 0.7 ? '✦' : '·',
          color: pick(SPARK_COLORS),
        },
  )
}

// Mutual "Loving it": cobalt sparkles (Spark) or flames (Play) rising over
// the chat for 8 seconds. Decorative only — no pointer events, hidden for
// reduced motion (index.css).
export default function VibeCelebration({ mode }: { mode: 'spark' | 'play' }) {
  const play = mode === 'play'
  const items = useMemo(() => particles(play), [play])
  return (
    <div className="zy-vibe-layer pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden>
      {play && (
        <div className="zy-vibe-glow absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-[#E03131]/35 via-[#FF6B35]/10 to-transparent" />
      )}
      {!play && <div className="absolute inset-x-0 bottom-0 h-1/4 bg-gradient-to-t from-[#1B4FD8]/20 to-transparent" />}
      {items.map((p, i) => (
        <span
          key={i}
          className={`zy-vibe-particle ${play ? 'zy-vibe-flame' : ''} leading-none`}
          style={
            {
              left: `${p.left}%`,
              fontSize: `${p.glyph === '●' ? p.size / 3 : p.size}px`,
              color: p.color,
              textShadow: `0 0 ${p.glyph === '🔥' ? 0 : p.size / 2}px ${p.color}`,
              '--zy-delay': `${p.delay}s`,
              '--zy-dur': `${p.duration}s`,
              '--zy-drift': `${p.drift}px`,
              '--zy-spin': `${p.spin}deg`,
            } as CSSProperties
          }
        >
          {p.glyph}
        </span>
      ))}
    </div>
  )
}
