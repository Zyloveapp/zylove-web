import { createPortal } from 'react-dom'

// Full-screen moment after onboarding when someone earns the founder badge.
// The caller navigates on after ~1.5s.
export default function FounderCelebration({ number }: { number: number }) {
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
        Austin Founding Circle · Member #{number}
      </p>
      <p className="zy-founder-in mt-1 text-white/70 [animation-delay:300ms]">One of the first 100.</p>
    </div>,
    document.body,
  )
}
