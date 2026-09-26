import { useEffect } from 'react'

const AUTO_DISMISS_MS = 3000

export default function MatchOverlay({ name, onDone }: { name: string; onDone: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, AUTO_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [onDone])

  return (
    <button
      type="button"
      onClick={onDone}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-gray-950/95 px-6 text-center"
    >
      <span className="mb-6 text-6xl text-[#1B4FD8]">✦</span>
      <span className="text-3xl font-bold text-white">It's a match with {name}!</span>
      <span className="mt-4 text-sm text-white/40">Taking you to your matches…</span>
    </button>
  )
}
