import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { WAITLIST_CONSENT_TEXT } from '../config/smsConsent'
import { FOUNDER_BENEFITS, FOUNDER_CAPACITY_PER_CITY, FOUNDER_TERMS_SHORT } from '../config/founderCopy'
import { lastLocationDenied, requestLocation, saveUserLocation } from '../services/location'
import { checkArea, joinFounderLine, joinWaitlistTexts, leaveWaitlist, type AreaView } from '../services/waitlist'
import { friendlyError } from '../services/errors'

// Austin-only launch: a new account shares its location before anything
// else. Inside a Founding or Live city it goes on to onboarding (onAdmitted);
// outside, it's on the waitlist for the nearest city, which needs text
// consent — without it the account and number are removed
// (functions/src/waitlist.ts). The texts are plain account notices; the
// screens carry the energy (Matthew, 2026-10-09).

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function Screen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 px-4 py-10 text-white">
      <div className="w-full max-w-sm">
        <p className="mb-6 text-center text-2xl font-bold">✦ Zylove</p>
        <h1 className="text-2xl font-bold leading-tight">{title}</h1>
        {children}
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-white/15 border-t-white" />
    </div>
  )
}

const primary = 'mt-5 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40'
const secondary = 'mt-2 w-full py-2 text-sm text-white/50 hover:text-white disabled:opacity-40'
const card = 'mt-5 rounded-2xl border border-white/10 bg-white/5 p-4'

type Waitlisted = Extract<AreaView, { status: 'waitlisted' }>
type Admitted = Extract<AreaView, { status: 'admitted' }>

function ActiveCities({ cities }: { cities: Waitlisted['available'] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className={secondary} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? 'Hide active cities' : 'See active cities'}
      </button>
      {open && (
        <ul className="mt-1 space-y-1 rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-white/80">
          {cities.length ? cities.map((c) => <li key={c.name}>✦ {c.name}, {c.state}</li>) : <li>None yet — soon.</li>}
        </ul>
      )}
    </>
  )
}

export default function AreaGate({ onAdmitted, onSignOut }: { onAdmitted: () => void; onSignOut: () => void }) {
  const [area, setArea] = useState<AreaView | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState(false)
  const [ticked, setTicked] = useState(false)
  // Continued without ticking: "We'd hate to lose your spot".
  const [askAgain, setAskAgain] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [removed, setRemoved] = useState(false)
  const autoTried = useRef(false)

  useEffect(() => {
    let cancelled = false
    checkArea()
      .then((v) => !cancelled && setArea(v))
      .catch(() => !cancelled && setLoadError(true))
    return () => {
      cancelled = true
    }
  }, [attempt])

  // Straight on to onboarding — except an account let in by its city's
  // unlock, which sees the activation screen first.
  const goStraight = area?.status === 'member' || (area?.status === 'admitted' && area.via !== 'unlock')
  useEffect(() => {
    if (goStraight) onAdmitted()
  }, [goStraight, onAdmitted])

  async function locate(): Promise<void> {
    setBusy(true)
    setError(null)
    setBlocked(false)
    const location = await requestLocation()
    if (!location) {
      if (lastLocationDenied()) setBlocked(true)
      else setError("We couldn't get your location. Try again.")
      setBusy(false)
      return
    }
    try {
      const next = await checkArea(location)
      // Admitted: the location is saved now too (the market, the founder offer).
      if (next.status === 'admitted') await saveUserLocation(location).catch(() => {})
      setArea(next)
    } catch (err) {
      setError(friendlyError(err, "We couldn't check your location. Try again."))
    }
    setBusy(false)
  }

  // Location already allowed: check without asking.
  useEffect(() => {
    if (area?.status !== 'unknown' || autoTried.current || !navigator.permissions) return
    autoTried.current = true
    navigator.permissions
      .query({ name: 'geolocation' })
      .then((s) => s.state === 'granted' && void locate())
      .catch(() => {})
    // locate reads current state when called.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area?.status])

  async function saveSpot(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await joinWaitlistTexts()
      setAskAgain(false)
      setArea((a) => (a?.status === 'waitlisted' ? { ...a, consented: true } : a))
    } catch (err) {
      setError(friendlyError(err, "Couldn't save your spot. Try again."))
    }
    setBusy(false)
  }

  async function interested(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const place = await joinFounderLine()
      setArea((a) => (a?.status === 'waitlisted' ? { ...a, founderLine: place } : a))
    } catch (err) {
      setError(friendlyError(err, "Couldn't save that. Try again."))
    }
    setBusy(false)
  }

  async function remove(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await leaveWaitlist()
      setRemoved(true)
    } catch (err) {
      setError(friendlyError(err, "Couldn't remove your number. Try again."))
    }
    setBusy(false)
  }

  if (removed) {
    return (
      <Screen title="You're off the list.">
        <p className="mt-2 text-white/70">If you change your mind, we'll be right here.</p>
        <button type="button" className={primary} onClick={onSignOut}>
          Close
        </button>
      </Screen>
    )
  }
  if (loadError) {
    return (
      <Screen title="We couldn't load your account">
        <button type="button" className={primary} onClick={() => { setLoadError(false); setAttempt((n) => n + 1) }}>
          Try again
        </button>
        <button type="button" className={secondary} onClick={onSignOut}>
          Sign out
        </button>
      </Screen>
    )
  }
  if (!area || goStraight) return <Spinner />

  if (area.status === 'admitted') {
    const a = area as Admitted
    return (
      <Screen title={`${a.cityName ?? 'Your city'} is ${a.cityLive ? 'live' : 'open'} — and you're in.`}>
        <p className="mt-2 text-white/70">Finish your profile and start connecting today, Zylove style.</p>
        {a.headStartUntil !== null && (
          <p className={`${card} text-sm text-white/80`}>
            <span className="text-[#6B8FFF]">✦</span> You have first dibs on a founding spot — claim it within 72 hours.
            Finish your profile and the invitation comes up first.
          </p>
        )}
        <button type="button" className={primary} onClick={onAdmitted}>
          Let's go
        </button>
      </Screen>
    )
  }

  if (area.status === 'unknown') {
    return (
      <Screen title="First, your location">
        <p className="mt-2 text-sm text-white/60">
          Zylove is launching city by city, so we need your location before you set up a profile.
        </p>
        {blocked && (
          <p role="alert" className="mt-4 text-sm text-amber-300">
            Location is blocked for Zylove. Turn it on in your browser's site settings, then try again.
          </p>
        )}
        {error && <p role="alert" className="mt-4 text-sm text-red-400">{error}</p>}
        <button type="button" className={primary} disabled={busy} onClick={() => void locate()}>
          {busy ? 'Checking…' : 'Share my location'}
        </button>
        <button type="button" className={secondary} disabled={busy} onClick={onSignOut}>
          Sign out
        </button>
      </Screen>
    )
  }

  const w = area as Waitlisted
  const launching = w.available.map((c) => `${c.name}, ${c.state}`)

  if (w.consented) {
    return (
      <Screen title={`You're on the ${w.cityName} waitlist.`}>
        <p className="mt-2 text-white/70">We'll text you the moment your account is activated.</p>
        <ActiveCities cities={w.available} />
        <div className={card}>
          {w.founderLine === null ? (
            <>
              <p className="text-lg font-bold">
                <span className="text-[#6B8FFF]">✦</span> Become a {w.cityName} Founder
              </p>
              <p className="mt-1 text-sm text-white/70">Only {FOUNDER_CAPACITY_PER_CITY} founding spots. Founders get:</p>
              <ul className="mt-2 space-y-1 text-sm text-white/70">
                {FOUNDER_BENEFITS(w.cityName).map((b) => (
                  <li key={b}>· {b}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-white/40">{FOUNDER_TERMS_SHORT}</p>
              <button type="button" className={primary} disabled={busy} onClick={() => void interested()}>
                {busy ? 'Saving…' : "I'm interested"}
              </button>
            </>
          ) : (
            <p className="text-sm text-white/80">
              You're #{w.founderLine} in line for a {w.cityName} founding spot. When your account is activated, you'll get
              first dibs.
            </p>
          )}
        </div>
        {error && <p role="alert" className="mt-4 text-sm text-red-400">{error}</p>}
        {confirmLeave ? (
          <div className={card} role="dialog" aria-label="Leave the waitlist">
            <p className="text-sm text-white/80">Leave the waitlist? We'll remove your phone number from our system.</p>
            <button type="button" className={`${primary} bg-red-600`} disabled={busy} onClick={() => void remove()}>
              {busy ? 'Removing…' : 'Remove me'}
            </button>
            <button type="button" className={secondary} disabled={busy} onClick={() => setConfirmLeave(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap justify-center gap-x-4 text-xs text-white/40">
            <button type="button" disabled={busy} className="py-2 hover:text-white" onClick={() => void locate()}>
              Moved? Check my location again
            </button>
            <button type="button" disabled={busy} className="py-2 hover:text-white" onClick={() => setConfirmLeave(true)}>
              Leave the waitlist
            </button>
            <button type="button" disabled={busy} className="py-2 hover:text-white" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        )}
      </Screen>
    )
  }

  return (
    <Screen title="We're so glad you found us.">
      <p className="mt-3 text-white/70">
        {launching.length ? (
          <>
            Zylove is launching in <strong className="text-white">{joinNames(launching)}</strong> first, and we're bringing it to
            more cities soon.
          </>
        ) : (
          <>Zylove is launching city by city, and we're bringing it to more cities soon.</>
        )}{' '}
        You're on the waitlist for <strong className="text-white">{w.cityName}</strong>.
      </p>
      <ActiveCities cities={w.available} />
      <div className={card}>
        <p className="font-semibold">Want to know the moment you're in?</p>
        <label className="mt-3 flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={ticked}
            onChange={(e) => setTicked(e.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 accent-[#1B4FD8]"
          />
          <span className="text-sm text-white/80">{WAITLIST_CONSENT_TEXT}</span>
        </label>
        <p className="mt-2 text-xs text-white/40">
          <Link to="/sms-terms" target="_blank" rel="noreferrer" className="underline hover:text-white">
            SMS Terms
          </Link>{' '}
          ·{' '}
          <Link to="/privacy" target="_blank" rel="noreferrer" className="underline hover:text-white">
            Privacy Policy
          </Link>
        </p>
      </div>
      {error && !askAgain && <p role="alert" className="mt-4 text-sm text-red-400">{error}</p>}
      <button type="button" className={primary} disabled={busy} onClick={() => (ticked ? void saveSpot() : setAskAgain(true))}>
        {busy && !askAgain ? 'Saving…' : 'Save my spot'}
      </button>
      <button type="button" className={secondary} disabled={busy} onClick={onSignOut}>
        Sign out
      </button>
      {askAgain && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="lose-spot-title"
          className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 backdrop-blur-sm lg:items-center lg:p-4"
        >
          <div className="w-full rounded-t-2xl border border-white/10 bg-gray-950 p-6 text-white lg:max-w-sm lg:rounded-2xl">
            <h2 id="lose-spot-title" className="text-xl font-bold">
              We'd hate to lose your spot
            </h2>
            <p className="mt-2 text-sm text-white/70">
              We only text you when your account is activated — no spam, ever. Without text permission we can't keep you on the{' '}
              {w.cityName} waitlist, and we'll remove your phone number from our system.
            </p>
            {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
            <button
              type="button"
              className={primary}
              disabled={busy}
              onClick={() => {
                setTicked(true)
                void saveSpot()
              }}
            >
              {busy ? 'Saving…' : 'Turn on texts'}
            </button>
            <button type="button" className={secondary} disabled={busy} onClick={() => void remove()}>
              Remove me
            </button>
          </div>
        </div>
      )}
    </Screen>
  )
}
