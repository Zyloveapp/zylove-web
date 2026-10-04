import { createPortal } from 'react-dom'
import { FOUNDER_CAPACITY_PER_CITY } from '../config/founderCopy'

// Full-screen moment after onboarding when someone earns the founder badge.
// The caller navigates on after ~1.5s. Without a cityName the lines go
// city-neutral rather than naming the wrong city.
export default function FounderCelebration({ number, cityName }: { number: number; cityName?: string }) {
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[#1B4FD8] px-6 text-center text-white"
    >
      <span className="zy-founder-spark text-7xl leading-none" aria-hidden>
        ✦
      </span>
      <p className="zy-founder-in mt-6 text-5xl font-black tracking-tight">✦ You're in.</p>
      <p className="zy-founder-in mt-3 text-lg font-semibold text-white/90 [animation-delay:150ms]">
        {cityName ? `${cityName} Founding Circle` : 'Founding Circle'} · Member #{number}
      </p>
      <p className="zy-founder-in mt-1 text-white/70 [animation-delay:300ms]">
        One of the first {FOUNDER_CAPACITY_PER_CITY} {cityName ? `${cityName} founders` : 'founders in your city'}.
      </p>
    </div>,
    document.body,
  )
}
