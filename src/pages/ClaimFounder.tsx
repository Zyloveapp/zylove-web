import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../services/firebase'
import { useAuthStore } from '../store/authStore'
import { cityById, getNearestCity, type ZyloveCity } from '../config/cities'
import { bucketFor, claimFounderBadge, spotOpen } from '../services/founders'
import { clearAfterLogin } from '../services/afterLogin'
import { FounderBenefits } from '../components/FounderInvite'
import FounderCelebration from '../components/FounderCelebration'

const CELEBRATION_MS = 1500

type View =
  | { kind: 'loading' }
  | { kind: 'founder' } // already one
  | { kind: 'invalid' }
  | { kind: 'elsewhere'; city: ZyloveCity } // their location is in another city, or none
  | { kind: 'available'; city: ZyloveCity }
  | { kind: 'taken'; city: ZyloveCity }
  | { kind: 'missed' }
  | { kind: 'celebrate'; number: number; cityName: string }

// /claim-founder?city=austin&gender=women — the link in the "a founder spot
// just opened" text (founderActivity.ts). The spot is checked for the
// viewer's own half and location, as assignFounderBadge will, so a
// forwarded link never promises something the server would refuse.
export default function ClaimFounder() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const cityId = params.get('city')
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    clearAfterLogin()
  }, [])

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    const city = cityById(cityId)
    if (!city) {
      setView({ kind: 'invalid' })
      return
    }
    void (async () => {
      try {
        const user = (await getDoc(doc(db, 'users', uid))).data()
        if (cancelled) return
        if (user?.isFounder === true) return setView({ kind: 'founder' })
        const lat = user?.locationLat
        const lng = user?.locationLng
        // No saved location: the claim asks for one.
        if (typeof lat === 'number' && typeof lng === 'number' && getNearestCity(lat, lng)?.id !== city.id) {
          return setView({ kind: 'elsewhere', city })
        }
        const open = await spotOpen(city.id, bucketFor(user?.genderIdentity))
        if (!cancelled) setView({ kind: open ? 'available' : 'taken', city })
      } catch {
        if (!cancelled) setView({ kind: 'taken', city })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [uid, cityId])

  async function claim(city: ZyloveCity) {
    setBusy(true)
    setError(null)
    const result = await claimFounderBadge(uid)
    setBusy(false)
    if (!result) return setError("Couldn't claim the spot right now. Try again.")
    if (result.eligible) {
      setView({ kind: 'celebrate', number: result.cohortNumber, cityName: result.cityName ?? city.name })
      setTimeout(() => navigate('/discover', { replace: true }), CELEBRATION_MS)
      return
    }
    if (result.reason === 'already_assigned') return navigate('/discover', { replace: true })
    if (result.reason === 'outside_coverage') return setView({ kind: 'elsewhere', city })
    setView({ kind: 'missed' })
  }

  if (view.kind === 'founder') return <Navigate to="/discover" replace />
  if (view.kind === 'celebrate') return <FounderCelebration number={view.number} cityName={view.cityName} />

  return (
    <div className="flex min-h-[calc(100dvh-7rem)] flex-col items-center justify-center bg-gray-950 px-6 py-10 text-center text-white lg:min-h-[calc(100dvh-7.5rem)]">
      <div className="w-full max-w-md">
        {view.kind === 'loading' && (
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        )}

        {view.kind === 'available' && (
          <>
            <h1 className="text-4xl font-black tracking-tight">
              <span className="text-[#6B8FFF]">✦</span> You're invited.
            </h1>
            <p className="mt-3 text-lg font-semibold text-white/90">A {view.city.name} founder spot is available.</p>
            <div className="mt-6">
              <FounderBenefits cityName={view.city.name} />
            </div>
            {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
            <button
              type="button"
              onClick={() => void claim(view.city)}
              disabled={busy}
              className="mt-8 w-full rounded-xl bg-[#1B4FD8] py-3.5 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Claiming…' : '✦ Claim my founder spot'}
            </button>
          </>
        )}

        {(view.kind === 'taken' || view.kind === 'missed') && (
          <>
            <h1 className="text-3xl font-bold">{view.kind === 'missed' ? 'Just missed it' : 'That spot is taken'}</h1>
            <p className="mt-4 text-white/60">
              Someone just claimed that spot. You'll be the first to know when another opens.
            </p>
            <BackButton onClick={() => navigate('/discover', { replace: true })} />
          </>
        )}

        {view.kind === 'elsewhere' && (
          <>
            <h1 className="text-3xl font-bold">This spot is for {view.city.name}</h1>
            <p className="mt-4 text-white/60">
              Founder spots go to people in that city, and your location puts you somewhere else. You'll hear from us when
              your own city has a spot.
            </p>
            <BackButton onClick={() => navigate('/discover', { replace: true })} />
          </>
        )}

        {view.kind === 'invalid' && (
          <>
            <h1 className="text-3xl font-bold">This link isn't valid</h1>
            <p className="mt-4 text-white/60">It may be incomplete. Check the text we sent you and try again.</p>
            <BackButton onClick={() => navigate('/discover', { replace: true })} />
          </>
        )}
      </div>
    </div>
  )
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-8 w-full rounded-xl bg-[#1B4FD8] py-3.5 font-semibold text-white transition-opacity hover:opacity-90"
    >
      Back to Zylove →
    </button>
  )
}
