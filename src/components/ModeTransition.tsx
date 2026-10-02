import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

// Copy and colours match mobile's ModeTransition exactly.
const COPY = {
  play: { emoji: '🔥', headline: 'Play time.', sub: 'Same you. Different energy.', color: '#E03131' },
  spark: { emoji: '✦', headline: 'Back to real.', sub: 'Find something worth keeping.', color: '#1B4FD8' },
} as const

// When the exit starts and when it's finished (onComplete).
const TIMING = {
  play: { exitAt: 1500, doneAt: 1800 },
  spark: { exitAt: 1600, doneAt: 1900 },
  reduced: { exitAt: 1200, doneAt: 1600 },
} as const

// 12 particles thrown out of the tear, alternating sides with varied reach.
const PARTICLES = Array.from({ length: 12 }, (_, i) => {
  const side = i % 2 === 0 ? -1 : 1
  const angle = ((i * 37) % 160) - 80 // spread −80°…80° around horizontal
  const reach = 120 + ((i * 53) % 140)
  const rad = (angle * Math.PI) / 180
  return { dx: side * Math.cos(rad) * reach, dy: Math.sin(rad) * reach, top: 30 + ((i * 29) % 40) }
})

// 8 dots around the centre that converge into the ✦.
const DOTS = Array.from({ length: 8 }, (_, i) => {
  const rad = (i / 8) * Math.PI * 2
  const reach = 110 + (i % 2) * 40
  return { dx: Math.cos(rad) * reach, dy: Math.sin(rad) * reach }
})

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function Words({ toMode, reduced }: { toMode: 'spark' | 'play'; reduced: boolean }) {
  const { emoji, headline, sub } = COPY[toMode]
  const play = toMode === 'play'
  return (
    <div className={`relative flex flex-col items-center px-10 text-center ${reduced ? 'zy-crossfade-in' : ''}`} aria-hidden>
      <span className={`mb-4 text-6xl leading-none text-white ${reduced ? '' : play ? 'zy-tear-emoji' : 'zy-crystal'}`}>{emoji}</span>
      <p className={`text-6xl font-black tracking-tighter text-white ${reduced ? '' : play ? 'zy-tear-headline' : 'zy-drain-headline'}`}>
        {headline}
      </p>
      <p className={`mt-3 text-xl font-medium text-white/75 ${reduced ? '' : play ? 'zy-tear-sub' : 'zy-drain-sub'}`}>{sub}</p>
    </div>
  )
}

// Spark → Play: a red crack splits the screen, the halves tear away with
// sparks flying, and the flame emerges on solid red.
function Tear() {
  return (
    <>
      <div className="absolute inset-0 bg-[#E03131]" />
      <div className="zy-tear-left absolute inset-y-0 left-0 w-1/2 origin-right bg-gray-950" />
      <div className="zy-tear-right absolute inset-y-0 right-0 w-1/2 origin-left bg-gray-950" />
      <div className="zy-crack-gone absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2">
        <div className="zy-crack h-full w-full bg-[#E03131] shadow-[0_0_16px_4px_rgba(224,49,49,0.8)]" />
      </div>
      {PARTICLES.map((p, i) => (
        <span
          key={i}
          aria-hidden
          className="zy-particle absolute left-1/2 h-1 w-1 rounded-full bg-[#FF6B6B] shadow-[0_0_6px_rgba(255,107,107,0.9)]"
          style={{ top: `${p.top}%`, '--dx': `${p.dx}px`, '--dy': `${p.dy}px` } as CSSProperties}
        />
      ))}
      <div className="zy-tear-edges pointer-events-none absolute inset-0" />
    </>
  )
}

// Play → Spark: two slowing red pulses, the red drains down, cobalt bleeds in
// from every edge, and the ✦ crystallizes from converging dots.
function Drain() {
  const bleed = 'absolute bg-[#1B4FD8]'
  return (
    <>
      <div className="zy-pulse-red absolute inset-0 bg-[#E03131]" />
      <div className="zy-drain-base absolute inset-0 bg-gray-950" />
      <div className={`zy-bleed-top ${bleed} inset-x-0 top-0`} />
      <div className={`zy-bleed-bottom ${bleed} inset-x-0 bottom-0`} />
      <div className={`zy-bleed-left ${bleed} inset-y-0 left-0`} />
      <div className={`zy-bleed-right ${bleed} inset-y-0 right-0`} />
      <div className="zy-drain-red absolute inset-0 bg-gradient-to-b from-[#E03131] to-[#8B1A1A]" />
      {DOTS.map((d, i) => (
        <span
          key={i}
          aria-hidden
          className="zy-converge absolute left-1/2 top-1/2 -ml-1 -mt-1 h-2 w-2 rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]"
          style={{ '--dx': `${d.dx}px`, '--dy': `${d.dy}px` } as CSSProperties}
        />
      ))}
      <div className="zy-drain-edges pointer-events-none absolute inset-0" />
    </>
  )
}

// Full-screen mode change: "the tear" into Play, "the drain" back to Spark.
// Automatic only, no tap to dismiss (as on mobile); onComplete fires when
// it's gone, and the caller switches the mode then.
export default function ModeTransition({ toMode, onComplete }: { toMode: 'spark' | 'play'; onComplete: () => void }) {
  const [reduced] = useState(prefersReducedMotion)
  const [exiting, setExiting] = useState(false)
  const { headline, sub, color } = COPY[toMode]
  const timing = reduced ? TIMING.reduced : TIMING[toMode]

  // Latest callback, so a parent re-render never restarts the timers.
  const completeRef = useRef(onComplete)
  useEffect(() => {
    completeRef.current = onComplete
  })

  useEffect(() => {
    const exit = setTimeout(() => setExiting(true), timing.exitAt)
    const done = setTimeout(() => completeRef.current(), timing.doneAt)
    return () => {
      clearTimeout(exit)
      clearTimeout(done)
    }
  }, [timing])

  const exitClass = !exiting ? '' : reduced ? 'zy-crossfade-out' : toMode === 'play' ? 'zy-seal' : 'zy-settle'

  return createPortal(
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center overflow-hidden ${exitClass} ${
        exiting ? 'pointer-events-none' : ''
      }`}
      style={reduced ? { backgroundColor: color } : undefined}
      role="status"
      aria-live="polite"
      aria-label={`${headline} ${sub}`}
    >
      {!reduced && (toMode === 'play' ? <Tear /> : <Drain />)}
      <Words toMode={toMode} reduced={reduced} />
    </div>,
    document.body,
  )
}
