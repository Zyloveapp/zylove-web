import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../services/firebase'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import { setVisibility, subscribeVisibility, type Visibility, type VisibilityState } from '../services/visibility'
import PlayPinFlow from './PlayPinFlow'
import { subscribeSmsSettings } from '../services/notifications'
import ModeTransition from './ModeTransition'
import { PaywallModal } from './PaywallGate'
import { useSubscriptionStore } from '../store/subscriptionStore'
import { canAccess } from '../services/subscription'

const VISIBILITY: { value: Visibility; label: string; pill: string; description: string; dot: string; tone: string }[] = [
  {
    value: 'active',
    label: 'Active',
    pill: '🟢 Active',
    description: "You're visible in Explore",
    dot: 'bg-emerald-500',
    tone: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400',
  },
  {
    value: 'hidden',
    label: 'Hidden',
    pill: '👻 Hidden',
    description: 'Hidden from Explore. Your links can still reach you.',
    dot: 'bg-gray-400',
    tone: 'border-white/20 bg-white/10 text-white/70',
  },
  {
    value: 'paused',
    label: 'On a break',
    pill: '☕ Break',
    description: 'Your profile is on a break.',
    dot: 'bg-amber-500',
    tone: 'border-amber-500/30 bg-amber-500/15 text-amber-400',
  },
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
      <button type="button" aria-label="Close" onClick={onClose} className="fixed inset-0 top-12 z-40 cursor-default bg-black/30 lg:top-14" />
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

// Shown instead of the PIN when the user has no Play profile yet. Portaled
// to <body> so it sits above the header and nav.
function PlaySetupSheet({ onClose, onStart }: { onClose: () => void; onStart: () => void }) {
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="play-setup-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full rounded-t-2xl bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-sm lg:rounded-2xl lg:pb-6">
        <p className="text-3xl" aria-hidden>
          🔴
        </p>
        <h2 id="play-setup-title" className="mt-3 text-xl font-bold">
          Set up your Play profile
        </h2>
        <p className="mt-2 text-sm text-white/60">
          Play is a separate experience with its own profile. Set it up to get started.
        </p>
        <button
          type="button"
          onClick={onStart}
          autoFocus
          className="mt-6 w-full rounded-xl bg-[#E03131] py-3 font-semibold text-white transition-opacity hover:opacity-90"
        >
          Get started
        </button>
        <button type="button" onClick={onClose} className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white">
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  )
}

// Persistent top bar on every protected page: wordmark, mode pill, visibility
// and settings. Going into Play asks for the Play PIN; either way the
// "Play time." / "Back to real." transition plays before the mode changes.
export default function Header() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const mode = useModeStore((s) => s.mode)
  const setMode = useModeStore((s) => s.setMode)
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [visibility, setVisibilityState] = useState<VisibilityState | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [pinFlow, setPinFlow] = useState(false)
  const [playSetup, setPlaySetup] = useState(false)
  const [checkingPlay, setCheckingPlay] = useState(false)
  const [playPaywall, setPlayPaywall] = useState(false)
  const tier = useSubscriptionStore((s) => (s.uid === uid ? s.tier : null))
  const trialDaysLeft = useSubscriptionStore((s) => (s.uid === uid ? s.daysLeft : null))
  // Last week of the trial: a quiet nudge under the header.
  const showTrialBanner = tier === 'trial' && trialDaysLeft !== null && trialDaysLeft <= 7
  // The mode being switched to while its transition plays.
  const [transition, setTransition] = useState<'spark' | 'play' | null>(null)

  useEffect(() => {
    if (!uid) return
    return subscribeVisibility(uid, setVisibilityState, () => setVisibilityState(null))
  }, [uid])

  // ⚙ gets a dot until SMS notifications have been set up (on or off).
  const [smsSetUp, setSmsSetUp] = useState<{ uid: string; done: boolean } | null>(null)
  useEffect(() => {
    if (!uid) return
    return subscribeSmsSettings(
      uid,
      (s) => setSmsSetUp({ uid, done: s.enabled !== null }),
      () => setSmsSetUp(null),
    )
  }, [uid])
  const settingsDot = smsSetUp?.uid === uid && !smsSetUp.done

  // Just finished Play onboarding: drop the param and run the normal way in —
  // PIN (setup, since there's none yet), then the "Play time." transition.
  useEffect(() => {
    if (searchParams.get('play_setup_complete') !== 'true') return
    const next = new URLSearchParams(searchParams)
    next.delete('play_setup_complete')
    setSearchParams(next, { replace: true })
    setPinFlow(true)
  }, [searchParams, setSearchParams])

  const isPlay = mode === 'play'
  const current = visibility?.[mode] ?? null
  const dot = VISIBILITY.find((o) => o.value === current)

  // Into Play: needs Play access (Elite or trial), a Play profile, then the
  // PIN. Back to Spark needs none of it.
  async function togglePill() {
    if (transition) return
    if (isPlay) return setTransition('spark')
    if (checkingPlay) return
    if (tier !== null && !canAccess(tier, 'play_mode')) return setPlayPaywall(true)
    setCheckingPlay(true)
    // A failed read shouldn't lock anyone out of Play: fall through to the PIN.
    const hasPlay = await getDoc(doc(db, `users/${uid}/playProfile/data`))
      .then((snap) => snap.exists())
      .catch(() => true)
    setCheckingPlay(false)
    if (hasPlay) setPinFlow(true)
    else setPlaySetup(true)
  }

  function pick(v: Visibility) {
    setSheetOpen(false)
    if (v !== current) setVisibility(mode, v).catch(() => {})
  }

  return (
    <header
      className={`sticky top-0 z-40 h-12 border-b bg-gray-950 transition-colors lg:h-14 ${
        isPlay ? 'border-[#E03131]/20' : 'border-white/10'
      }`}
    >
      <div className="relative mx-auto grid h-full max-w-5xl grid-cols-3 items-center gap-x-4 px-4 lg:max-w-6xl lg:gap-x-8 lg:px-8">
        {/* Wordmark: "✦ Zy" in the mode color, "love" in white. */}
        <Link to="/discover" className="justify-self-start whitespace-nowrap text-sm font-semibold lg:text-xl lg:font-bold">
          <span className={`transition-colors ${isPlay ? 'text-[#E03131]' : 'text-[#1B4FD8]'}`}>
            ✦ <span className="font-bold">Zy</span>
          </span>
          <span className="font-bold text-white">love</span>
        </Link>

        <button
          type="button"
          onClick={togglePill}
          disabled={checkingPlay || transition !== null}
          aria-label={isPlay ? 'Play mode — switch to Spark' : 'Spark mode — switch to Play'}
          className={`justify-self-center rounded-full border px-3 py-1 text-xs font-semibold transition-colors lg:px-4 lg:py-1.5 lg:text-sm ${
            isPlay
              ? 'zy-play-pulse border-[#E03131]/30 bg-[#E03131]/20 text-red-400'
              : 'border-[#1B4FD8]/30 bg-[#1B4FD8]/20 text-[#6B8FFF]'
          }`}
        >
          {isPlay ? '🔴 Play' : '🔵 Spark'}
        </button>

        <div className="flex items-center gap-1 justify-self-end lg:gap-2">
          <button
            type="button"
            onClick={() => setSheetOpen((o) => !o)}
            disabled={current === null}
            aria-label={`Visibility: ${dot?.label ?? 'loading'}`}
            aria-expanded={sheetOpen}
            className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold transition-opacity hover:opacity-80 lg:px-4 lg:py-1.5 lg:text-sm ${
              dot?.tone ?? 'border-white/10 bg-white/5 text-white/30'
            }`}
          >
            {dot?.pill ?? '…'}
          </button>
          <Link
            to="/settings"
            aria-label={settingsDot ? 'Settings — set up notifications' : 'Settings'}
            className="relative flex items-center justify-center rounded-full p-2 text-white/50 hover:bg-white/10 hover:text-white"
          >
            <span className="flex h-6 w-6 items-center justify-center text-2xl leading-none" aria-hidden>
              ⚙
            </span>
            {settingsDot && (
              <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-[#1B4FD8] ring-2 ring-gray-950" aria-hidden />
            )}
          </Link>
        </div>

        {sheetOpen && current && <VisibilitySheet current={current} onPick={pick} onClose={() => setSheetOpen(false)} />}
      </div>

      {playSetup && (
        <PlaySetupSheet
          onClose={() => setPlaySetup(false)}
          onStart={() => {
            setPlaySetup(false)
            navigate('/play-onboarding')
          }}
        />
      )}

      {transition && (
        <ModeTransition
          toMode={transition}
          onComplete={() => {
            setMode(transition)
            setTransition(null)
          }}
        />
      )}

      {showTrialBanner && (
        <div className="absolute inset-x-0 top-full border-b border-amber-500/20 bg-amber-500/10 px-4 py-1.5 text-center text-xs text-amber-200 backdrop-blur">
          ✦ {trialDaysLeft} {trialDaysLeft === 1 ? 'day' : 'days'} left in your free trial ·{' '}
          <Link to="/upgrade" className="font-semibold underline underline-offset-2 hover:text-white">
            Upgrade
          </Link>
        </div>
      )}

      {playPaywall && <PaywallModal feature="play_mode" onClose={() => setPlayPaywall(false)} />}

      {pinFlow && (
        <PlayPinFlow
          uid={uid}
          purpose="unlock"
          onDone={() => {
            setPinFlow(false)
            setTransition('play')
          }}
          onCancel={() => setPinFlow(false)}
        />
      )}
    </header>
  )
}
