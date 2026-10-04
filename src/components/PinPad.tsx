import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PIN_LENGTH } from '../services/playPin'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back'] as const

interface PinPadProps {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  // Toggle to replay the wrong-PIN shake.
  shake?: boolean
}

// Four dots plus a number pad. Digits can also be typed on a keyboard.
export default function PinPad({ value, onChange, disabled = false, shake = false }: PinPadProps) {
  function press(key: string) {
    if (disabled) return
    if (key === 'back') onChange(value.slice(0, -1))
    else if (value.length < PIN_LENGTH) onChange(value + key)
  }

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (disabled) return
      if (/^\d$/.test(e.key) && value.length < PIN_LENGTH) onChange(value + e.key)
      else if (e.key === 'Backspace') onChange(value.slice(0, -1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [value, onChange, disabled])

  return (
    <div className="flex flex-col items-center">
      <div className={`flex gap-5 ${shake ? 'zy-shake' : ''}`} aria-label={`${value.length} of ${PIN_LENGTH} digits entered`}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span
            key={i}
            className={`h-4 w-4 rounded-full border transition-colors ${
              i < value.length
                ? 'zy-dot-fill border-[#E03131] bg-[#E03131] shadow-[0_0_8px_rgba(224,49,49,0.6)]'
                : 'border-white/20 bg-transparent'
            }`}
          />
        ))}
      </div>
      <div className="mt-10 grid grid-cols-3 gap-4">
        {KEYS.map((key, i) =>
          key === '' ? (
            <span key={i} />
          ) : (
            <button
              key={key}
              type="button"
              onClick={() => press(key)}
              disabled={disabled}
              aria-label={key === 'back' ? 'Delete' : key}
              className="flex h-[72px] w-[72px] items-center justify-center rounded-full border border-transparent bg-white/10 text-2xl font-medium text-white transition-[transform,background-color,border-color] duration-100 hover:bg-white/15 active:scale-95 active:border-[#E03131]/40 active:bg-[#E03131]/30 disabled:opacity-30"
            >
              {key === 'back' ? '⌫' : key}
            </button>
          ),
        )}
      </div>
    </div>
  )
}

// Full-screen dark shell shared by the (Play) PIN screens, with a red glow.
// Portaled to <body> so it sits above the sticky header and bottom nav.
export function PinScreen({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex flex-col items-center justify-center overflow-y-auto bg-gray-950/[0.98] px-6 py-10 text-center text-white"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pin-title"
    >
      <div
        className="pointer-events-none fixed inset-0"
        style={{ background: 'radial-gradient(ellipse at center, rgba(224, 49, 49, 0.15) 0%, transparent 70%)' }}
        aria-hidden
      />
      <h2 id="pin-title" className="relative text-2xl font-bold">
        {title}
      </h2>
      {subtitle && <p className="relative mt-2 max-w-xs text-sm text-white/60">{subtitle}</p>}
      <div className="relative mt-10">{children}</div>
    </div>,
    document.body,
  )
}
