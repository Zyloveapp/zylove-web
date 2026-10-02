import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

// Copy and colours match mobile's ModeTransition exactly.
const COPY = {
  play: { emoji: '🔥', headline: 'Play time.', sub: 'Same you. Different energy.', color: '#E03131' },
  spark: { emoji: '✦', headline: 'Back to real.', sub: 'Find something worth keeping.', color: '#1B4FD8' },
} as const

const BURST_SIZE = 40 // px, the circle the flood starts from

// Burst 0–180ms, emoji + headline from 150ms, subline 350–550ms, hold 700ms,
// implode 350ms.
const EXIT_AT_MS = 1250
const DONE_AT_MS = EXIT_AT_MS + 350
// Reduced motion: solid colour, text fades in (500ms), holds, fades out.
const REDUCED_EXIT_AT_MS = 1000
const REDUCED_DONE_AT_MS = REDUCED_EXIT_AT_MS + 350

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// Full-screen "Play time." / "Back to real." moment between modes. Automatic
// only, no tap to dismiss (as on mobile); onComplete fires when it's gone.
export default function ModeTransition({ toMode, onComplete }: { toMode: 'spark' | 'play'; onComplete: () => void }) {
  const { emoji, headline, sub, color } = COPY[toMode]
  const [reduced] = useState(prefersReducedMotion)
  const [exiting, setExiting] = useState(false)
  // Enough to cover the viewport corner to corner from the centre.
  const [burstScale] = useState(() => (Math.hypot(window.innerWidth, window.innerHeight) / BURST_SIZE) * 1.05)

  // Latest callback, so a parent re-render never restarts the timers.
  const completeRef = useRef(onComplete)
  useEffect(() => {
    completeRef.current = onComplete
  })

  useEffect(() => {
    const exit = setTimeout(() => setExiting(true), reduced ? REDUCED_EXIT_AT_MS : EXIT_AT_MS)
    const done = setTimeout(() => completeRef.current(), reduced ? REDUCED_DONE_AT_MS : DONE_AT_MS)
    return () => {
      clearTimeout(exit)
      clearTimeout(done)
    }
  }, [reduced])

  const exitClass = exiting ? (reduced ? 'zy-fade-out-plain' : 'zy-implode-out') : ''

  return createPortal(
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center overflow-hidden ${exitClass}`}
      style={reduced ? { backgroundColor: color } : undefined}
      role="status"
      aria-live="polite"
      aria-label={`${headline} ${sub}`}
    >
      {!reduced && (
        <span
          aria-hidden
          className="zy-burst-expand absolute left-1/2 top-1/2"
          style={
            {
              width: BURST_SIZE,
              height: BURST_SIZE,
              marginLeft: -BURST_SIZE / 2,
              marginTop: -BURST_SIZE / 2,
              backgroundColor: color,
              '--burst-scale': burstScale,
            } as CSSProperties
          }
        />
      )}

      <div className={`relative flex flex-col items-center px-10 text-center ${reduced ? 'zy-fade-in-plain' : ''}`} aria-hidden>
        <span className={`mb-4 text-6xl leading-none text-white ${reduced ? '' : 'zy-spin-scale'}`}>{emoji}</span>
        <p className={`text-6xl font-black tracking-tighter text-white ${reduced ? '' : 'zy-slam-in'}`}>{headline}</p>
        <p className={`mt-3 text-xl font-medium text-white/75 ${reduced ? '' : 'zy-slide-up-fade'}`}>{sub}</p>
      </div>
    </div>,
    document.body,
  )
}
