import { useState } from 'react'

// The way out of onboarding, in the header: one tap asks, a second confirms
// (so a stray tap doesn't throw away progress).
export default function ExitLink({
  label,
  question,
  onConfirm,
  disabled = false,
}: {
  label: string
  // e.g. "Sign out? Your answers so far will be cleared."
  question: string
  onConfirm: () => void
  disabled?: boolean
}) {
  const [asking, setAsking] = useState(false)

  if (!asking) {
    return (
      <button
        type="button"
        onClick={() => setAsking(true)}
        disabled={disabled}
        className="text-xs font-medium text-white/50 underline-offset-2 hover:text-white hover:underline disabled:opacity-40"
      >
        {label}
      </button>
    )
  }
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs" role="group" aria-label={question}>
      <span className="text-white/60">{question}</span>
      <button
        type="button"
        onClick={onConfirm}
        disabled={disabled}
        autoFocus
        className="font-semibold text-white underline underline-offset-2 disabled:opacity-40"
      >
        {label}
      </button>
      <button type="button" onClick={() => setAsking(false)} className="text-white/50 hover:text-white">
        Stay
      </button>
    </div>
  )
}
