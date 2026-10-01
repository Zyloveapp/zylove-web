import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import { setVisibility, subscribeVisibility, type Visibility, type VisibilityState } from '../services/visibility'
import PlayPinFlow from './PlayPinFlow'

const VISIBILITY: { value: Visibility; label: string; description: string; dot: string }[] = [
  { value: 'active', label: 'Active', description: "You're visible in discovery", dot: 'bg-emerald-500' },
  { value: 'hidden', label: 'Hidden', description: 'Hidden from discovery. Matches can still reach you.', dot: 'bg-gray-400' },
  { value: 'paused', label: 'On a break', description: 'Your profile is on a break.', dot: 'bg-amber-500' },
]

// Drops down under the header; any tap outside closes it.
function VisibilitySheet({ current, onPick, onClose }: { current: Visibility; onPick: (v: Visibility) => void; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <button type="button" aria-label="Close" onClick={onClose} className="fixed inset-0 top-12 z-40 cursor-default bg-black/30" />
      <div className="zy-drop absolute right-2 top-[calc(100%+0.5rem)] z-50 w-72 overflow-hidden rounded-2xl border border-white/10 bg-gray-900 shadow-2xl">
        <p className="px-4 pt-3 text-xs font-semibold uppercase tracking-widest text-white/40">Profile visibility</p>
        <ul className="p-2">
          {VISIBILITY.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                onClick={() => onPick(o.value)}
                aria-pressed={o.value === current}
                className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-white/5 ${
                  o.value === current ? 'bg-white/[0.07]' : ''
                }`}
              >
                <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${o.dot}`} aria-hidden />
                <span>
                  <span className="block text-sm font-semibold text-white">
                    {o.label}
                    {o.value === current && <span className="ml-2 text-xs font-normal text-white/40">current</span>}
                  </span>
                  <span className="block text-xs text-white/50">{o.description}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}

// Persistent top bar on every protected page: wordmark, mode pill, visibility
// and settings. Going into Play asks for the Play PIN; back to Spark is instant.
export default function Header() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const mode = useModeStore((s) => s.mode)
  const setMode = useModeStore((s) => s.setMode)
  const [visibility, setVisibilityState] = useState<VisibilityState | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [pinFlow, setPinFlow] = useState(false)

  useEffect(() => {
    if (!uid) return
    return subscribeVisibility(uid, setVisibilityState, () => setVisibilityState(null))
  }, [uid])

  const isPlay = mode === 'play'
  const current = visibility?.[mode] ?? null
  const dot = VISIBILITY.find((o) => o.value === current)

  function togglePill() {
    if (isPlay) setMode('spark')
    else setPinFlow(true)
  }

  function pick(v: Visibility) {
    setSheetOpen(false)
    if (v !== current) setVisibility(mode, v).catch(() => {})
  }

  return (
    <header
      className={`sticky top-0 z-40 h-12 border-b bg-gray-950 transition-colors ${
        isPlay ? 'border-[#E03131]/20' : 'border-white/10'
      }`}
    >
      <div className="relative mx-auto grid h-full max-w-5xl grid-cols-3 items-center px-4">
        <Link to="/discover" className="justify-self-start text-sm font-semibold text-white">
          ✦ Zylove
        </Link>

        <button
          type="button"
          onClick={togglePill}
          aria-label={isPlay ? 'Play mode — switch to Spark' : 'Spark mode — switch to Play'}
          className={`justify-self-center rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
            isPlay
              ? 'zy-play-pulse border-[#E03131]/30 bg-[#E03131]/20 text-red-400'
              : 'border-[#1B4FD8]/30 bg-[#1B4FD8]/20 text-[#6B8FFF]'
          }`}
        >
          {isPlay ? '🔴 Play' : '🔵 Spark'}
        </button>

        <div className="flex items-center gap-1 justify-self-end">
          <button
            type="button"
            onClick={() => setSheetOpen((o) => !o)}
            disabled={current === null}
            aria-label={`Visibility: ${dot?.label ?? 'loading'}`}
            aria-expanded={sheetOpen}
            className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/10"
          >
            <span className={`h-3 w-3 rounded-full ${dot?.dot ?? 'bg-white/20'}`} />
          </button>
          <Link
            to="/settings"
            aria-label="Settings"
            className="flex h-9 w-9 items-center justify-center rounded-full text-lg text-white/50 hover:bg-white/10 hover:text-white"
          >
            ⚙
          </Link>
        </div>

        {sheetOpen && current && <VisibilitySheet current={current} onPick={pick} onClose={() => setSheetOpen(false)} />}
      </div>

      {pinFlow && (
        <PlayPinFlow
          uid={uid}
          purpose="unlock"
          onDone={() => {
            setPinFlow(false)
            setMode('play')
          }}
          onCancel={() => setPinFlow(false)}
        />
      )}
    </header>
  )
}
