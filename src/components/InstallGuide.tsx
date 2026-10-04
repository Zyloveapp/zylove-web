import { useEffect, useState } from 'react'
import { MODE_ACCENT, useModeStore } from '../store/modeStore'
import { createPortal } from 'react-dom'

type Platform = 'iphone' | 'android'

const STEPS: Record<Platform, string[]> = {
  iphone: [
    '📱 Open zylove.app in Safari (must be Safari, not Chrome)',
    'Tap the Share button at the bottom of the screen ⬆',
    'Scroll down and tap "Add to Home Screen"',
    'Tap "Add" in the top right',
    '✦ Zylove is now on your home screen',
  ],
  android: [
    '📱 Open zylove.app in Chrome',
    'Tap the three dots menu ⋮ in the top right',
    'Tap "Add to Home screen"',
    'Tap "Add"',
    '✦ Zylove is now on your home screen',
  ],
}

// Starts on the visitor's own platform; anything else defaults to iPhone.
function guessPlatform(): Platform {
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent) ? 'android' : 'iphone'
}

// "Add to Home Screen" steps for iPhone (Safari) and Android (Chrome).
export default function InstallGuide({ onClose }: { onClose: () => void }) {
  const accent = MODE_ACCENT[useModeStore((st) => st.mode)]
  const [tab, setTab] = useState<Platform>(guessPlatform)

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-guide-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full rounded-t-2xl bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-sm lg:rounded-2xl lg:pb-6">
        <h2 id="install-guide-title" className="text-xl font-bold">
          Add Zylove to your home screen
        </h2>

        <div className="mt-4 grid grid-cols-2 gap-1 rounded-xl bg-white/5 p-1" role="tablist">
          {(['iphone', 'android'] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={tab === p}
              onClick={() => setTab(p)}
              className={`rounded-lg py-2 text-sm font-semibold transition-colors ${
                tab === p ? `${accent.bg} text-white` : 'text-white/60 hover:text-white'
              }`}
            >
              {p === 'iphone' ? 'iPhone' : 'Android'}
            </button>
          ))}
        </div>

        <ol className="mt-5 space-y-3" role="tabpanel">
          {STEPS[tab].map((step, i) => (
            <li key={step} className="flex gap-3">
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${accent.softBg} text-xs font-semibold ${accent.text}`}>
                {i + 1}
              </span>
              <span className="text-sm text-white/80">{step}</span>
            </li>
          ))}
        </ol>

        <p className="mt-5 text-center text-xs text-white/40">Once installed, Zylove launches fullscreen just like a native app.</p>

        <button
          type="button"
          onClick={onClose}
          autoFocus
          className={`mt-4 w-full rounded-xl ${accent.bg} py-3 font-semibold text-white transition-opacity hover:opacity-90`}
        >
          Got it
        </button>
      </div>
    </div>,
    document.body,
  )
}
