import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// Copy and colours match mobile's ModeTransition exactly.
const COPY = {
  play: { emoji: '🔥', headline: 'Play time.', sub: 'Same you. Different energy.', color: '#E03131' },
  spark: { emoji: '✦', headline: 'Back to real.', sub: 'Find something worth keeping.', color: '#1B4FD8' },
} as const

// When the exit starts and when it's finished (onComplete). The keyframe
// timeline lives in index.css under "Mode transitions".
const TIMING = {
  play: { exitAt: 3200, doneAt: 4000 },
  // Settle starts at 3000 with a 200ms pause, so its 800ms fade ends at 4000.
  spark: { exitAt: 3000, doneAt: 4000 },
  reduced: { exitAt: 1100, doneAt: 1500 },
} as const

// Five veins through the centre, 36° apart (ten rays), 40–60% of the height.
const VEINS = [
  { angle: 0, height: 50 },
  { angle: 36, height: 60 },
  { angle: 72, height: 40 },
  { angle: 108, height: 55 },
  { angle: 144, height: 45 },
]

// 16 particles thrown out of the tear: alternating sides, 3–6px, ~200px
// reach, staggered speeds so they don't move as one.
const PARTICLES = Array.from({ length: 16 }, (_, i) => {
  const side = i % 2 === 0 ? -1 : 1
  const angle = ((i * 37) % 150) - 75 // −75°…75° around horizontal
  const reach = 150 + ((i * 53) % 110)
  const rad = (angle * Math.PI) / 180
  return {
    dx: side * Math.cos(rad) * reach,
    dy: Math.sin(rad) * reach,
    top: 25 + ((i * 29) % 50),
    size: 3 + (i % 4),
    duration: 700 + ((i * 61) % 300),
    delay: 900 + ((i * 17) % 60),
  }
})

// 12 cobalt dots on a 100px ring that orbit, then get pulled into the ✦.
const DOTS = Array.from({ length: 12 }, (_, i) => {
  const rad = (i / 12) * Math.PI * 2
  return { dx: Math.cos(rad) * 100, dy: Math.sin(rad) * 100 }
})

// Small cobalt motes drifting up from the bottom during the hold.
const MOTES = Array.from({ length: 10 }, (_, i) => ({
  left: 8 + ((i * 37) % 84),
  duration: 1600 + ((i * 113) % 600),
  delay: 2500 + ((i * 71) % 600),
}))

const TRAIL = Array.from({ length: 8 }, (_, i) => i)

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function Center({ children }: { children: ReactNode }) {
  return <div className="pointer-events-none absolute inset-0 flex items-center justify-center">{children}</div>
}

function Words({ toMode, reduced }: { toMode: 'spark' | 'play'; reduced: boolean }) {
  const { emoji, headline, sub } = COPY[toMode]
  const play = toMode === 'play'
  const anim = (tear: string, drain: string) => (reduced ? '' : play ? tear : drain)
  return (
    <div className={`relative flex flex-col items-center px-10 text-center ${reduced ? 'mt-reduced-in' : ''}`} aria-hidden>
      <span className={`mb-4 inline-block text-6xl leading-none text-white ${anim('mt-tear-emoji', 'mt-crystal')}`}>
        <span className={`inline-block ${anim('mt-tear-emoji-spin', 'mt-crystal-spin')}`}>{emoji}</span>
      </span>
      <div className={`relative ${anim('mt-tear-headline', 'mt-drain-headline')}`}>
        <p className="text-6xl font-black tracking-tighter text-white">{headline}</p>
        {/* Shimmer: a tinted copy whose highlight band sweeps across the text. */}
        {!reduced && (
          <p
            className={`absolute inset-0 bg-clip-text text-6xl font-black tracking-tighter text-transparent ${
              play ? 'mt-tear-shimmer' : 'mt-drain-shimmer'
            }`}
          >
            {headline}
          </p>
        )}
      </div>
      <p className={`mt-3 text-xl font-medium text-white/75 ${anim('mt-tear-sub', 'mt-drain-sub')}`}>{sub}</p>
    </div>
  )
}

// Spark → Play: the screen dims, a shockwave and red veins spread from the
// centre, a crack flickers and holds, the halves tear apart with sparks
// flying, and the flame emerges on solid red.
function Tear() {
  return (
    <>
      <div className="mt-red-base absolute inset-0 bg-[#E03131]" />
      <div className="mt-tear-panel-left absolute inset-y-0 left-0 w-1/2 origin-right bg-gray-950" />
      <div className="mt-tear-panel-right absolute inset-y-0 right-0 w-1/2 origin-left bg-gray-950" />
      <Center>
        <div className="mt-shockwave aspect-square w-[120vw] shrink-0 rounded-full border-2 border-white/60 shadow-[0_0_60px_rgba(255,255,255,0.35)]" />
      </Center>
      <Center>
        {VEINS.map((v) => (
          <div key={v.angle} className="absolute" style={{ transform: `rotate(${v.angle}deg)` }}>
            <div
              className="mt-vein w-px bg-[#E03131] shadow-[0_0_6px_2px_rgba(224,49,49,0.8)]"
              style={{ height: `${v.height}vh` }}
            />
          </div>
        ))}
      </Center>
      <div className="mt-crack absolute inset-y-0 left-[calc(50%-1.5px)] w-[3px] bg-[#E03131] shadow-[0_0_20px_#E03131]" />
      {PARTICLES.map((p, i) => (
        <span
          key={i}
          aria-hidden
          className="mt-particle absolute left-1/2 rounded-full bg-[#FF6B6B] shadow-[0_0_6px_rgba(255,107,107,0.9)]"
          style={
            {
              top: `${p.top}%`,
              width: p.size,
              height: p.size,
              animationDuration: `${p.duration}ms`,
              animationDelay: `${p.delay}ms`,
              '--dx': `${p.dx}px`,
              '--dy': `${p.dy}px`,
            } as CSSProperties
          }
        />
      ))}
      <div className="mt-tear-edges pointer-events-none absolute inset-0" />
    </>
  )
}

// A cobalt bar growing in from one edge. Its bright leading edge starts thick
// and thins as it spreads, with a row of trail dots riding along it.
function Bleed({ side }: { side: 'top' | 'bottom' | 'left' | 'right' }) {
  const vertical = side === 'top' || side === 'bottom'
  const bar = {
    top: 'inset-x-0 top-0',
    bottom: 'inset-x-0 bottom-0',
    left: 'inset-y-0 left-0',
    right: 'inset-y-0 right-0',
  }[side]
  const edge = {
    top: 'inset-x-0 bottom-0',
    bottom: 'inset-x-0 top-0',
    left: 'inset-y-0 right-0',
    right: 'inset-y-0 left-0',
  }[side]
  const row = {
    top: 'inset-x-0 bottom-0 flex-row',
    bottom: 'inset-x-0 top-0 flex-row',
    left: 'inset-y-0 right-0 flex-col',
    right: 'inset-y-0 left-0 flex-col',
  }[side]
  return (
    <div className={`absolute bg-[#1B4FD8] ${bar} ${vertical ? 'mt-bleed-y' : 'mt-bleed-x'}`}>
      <div className={`absolute bg-[#6B8EF0] ${edge} ${vertical ? 'mt-edge-y' : 'mt-edge-x'}`} />
      <div className={`mt-trail-row absolute flex justify-around ${row}`}>
        {TRAIL.map((i) => (
          <span
            key={i}
            className="mt-trail-dot h-[3px] w-[3px] rounded-full bg-[#B4C6FF]"
            style={{ animationDelay: `${i * 60}ms` }}
          />
        ))}
      </div>
    </div>
  )
}

// Play → Spark: two slowing heartbeat pulses shake the screen, the red drains
// down as cobalt bleeds in from every edge (purple where they meet), and 12
// dots orbit, get pulled in, and flash into the ✦.
function Drain() {
  return (
    <>
      <div className="mt-heartbeat absolute inset-0 bg-[#E03131]" />
      <div className="mt-drain-base absolute inset-0 bg-gray-950" />
      <Bleed side="top" />
      <Bleed side="bottom" />
      <Bleed side="left" />
      <Bleed side="right" />
      <div className="mt-drain-red absolute inset-0 bg-gradient-to-b from-[#E03131] to-[#8B1A1A]" />
      <div className="mt-purple absolute inset-0 bg-[radial-gradient(circle_at_center,#7B3FC4_0%,transparent_60%)]" />
      <Center>
        <div className="mt-orbit relative h-0 w-0">
          {DOTS.map((d, i) => (
            <span
              key={i}
              aria-hidden
              className="mt-pull absolute -left-1 -top-1 h-2 w-2 rounded-full bg-white shadow-[0_0_8px_rgba(107,142,240,0.9)]"
              style={{ '--dx': `${d.dx}px`, '--dy': `${d.dy}px` } as CSSProperties}
            />
          ))}
        </div>
      </Center>
      <div className="mt-white-flash absolute inset-0 bg-[radial-gradient(circle_at_center,white_0%,transparent_55%)]" />
      {MOTES.map((m, i) => (
        <span
          key={i}
          aria-hidden
          className="mt-rise absolute bottom-0 h-1 w-1 rounded-full bg-[#B4C6FF]"
          style={{ left: `${m.left}%`, animationDuration: `${m.duration}ms`, animationDelay: `${m.delay}ms` }}
        />
      ))}
      <div className="mt-drain-edges pointer-events-none absolute inset-0" />
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

  const exitClass = !exiting ? '' : reduced ? 'mt-reduced-out' : toMode === 'play' ? 'mt-implode' : 'mt-settle'

  return createPortal(
    <div
      className={`fixed inset-0 z-[9999] overflow-hidden ${exitClass} ${exiting ? 'pointer-events-none' : ''}`}
      style={reduced ? { backgroundColor: color } : undefined}
      role="status"
      aria-live="polite"
      aria-label={`${headline} ${sub}`}
    >
      {/* Inner stage so the drain's heartbeat shake never fights the exit transform. */}
      <div className={`absolute inset-0 flex items-center justify-center ${!reduced && toMode === 'spark' ? 'mt-shake' : ''}`}>
        {!reduced && (toMode === 'play' ? <Tear /> : <Drain />)}
        <Words toMode={toMode} reduced={reduced} />
      </div>
      {/* The crack flashes back as the tear implodes. */}
      {!reduced && toMode === 'play' && (
        <div className="mt-crack-flash absolute inset-y-0 left-[calc(50%-1.5px)] w-[3px] bg-[#E03131] shadow-[0_0_20px_#E03131]" />
      )}
    </div>,
    document.body,
  )
}
