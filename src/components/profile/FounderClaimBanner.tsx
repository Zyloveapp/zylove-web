import { useEffect, useState } from 'react'
import { claimFounderBadge, dismissFounderInvite, founderOffer, type FounderOffer } from '../../services/founders'
import FounderInviteModal from '../FounderInvite'
import FounderCelebration from '../FounderCelebration'

const CELEBRATION_MS = 1500

// Own Spark profile, for people who chose "Maybe later" at onboarding:
// a quiet way back to the founder invitation while their city and half
// still have a spot. × hides it for good.
export default function FounderClaimBanner({
  uid,
  profile,
  onClaimed,
}: {
  uid: string
  profile: object
  onClaimed: () => void
}) {
  const p = profile as Record<string, unknown>
  const eligible = p.founderInviteShownAt != null && p.isFounder !== true && p.founderInviteDismissedAt == null
  const [offer, setOffer] = useState<FounderOffer | null>(null)
  const [hidden, setHidden] = useState(false)
  // The spot went while they were deciding.
  const [full, setFull] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [celebrate, setCelebrate] = useState<{ number: number; cityName: string } | null>(null)

  useEffect(() => {
    if (!eligible) return
    let cancelled = false
    founderOffer(uid, { ask: false }).then((o) => !cancelled && setOffer(o))
    return () => {
      cancelled = true
    }
  }, [uid, eligible])

  async function accept() {
    if (!offer) return
    setBusy(true)
    setError(null)
    const result = await claimFounderBadge(uid)
    setBusy(false)
    if (!result) return setError("Couldn't save your spot. Try again.")
    if (result.eligible) {
      setOpen(false)
      setCelebrate({ number: result.cohortNumber, cityName: result.cityName ?? offer.city.name })
      setTimeout(() => {
        setCelebrate(null)
        onClaimed()
      }, CELEBRATION_MS)
      return
    }
    setError(result.reason === 'cohort_full' ? 'Someone just took the last spot.' : "This spot isn't available to you.")
    setFull(true)
  }

  if (celebrate) return <FounderCelebration number={celebrate.number} cityName={celebrate.cityName} />
  if (!eligible || hidden || !offer) return null

  const cityName = offer.city.name
  return (
    <>
      {!full && (
        <div className="flex items-center gap-2 rounded-xl border border-[#1B4FD8]/30 bg-[#1B4FD8]/10 py-1 pl-4 pr-1 text-sm">
          <button type="button" onClick={() => setOpen(true)} className="flex-1 py-2 text-left text-[#B4C6FF] hover:text-white">
            ✦ Founder spots still available in {cityName} → <span className="font-semibold">Claim yours</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setHidden(true)
              void dismissFounderInvite(uid)
            }}
            aria-label="Don't show again"
            className="rounded-lg px-3 py-2 text-white/40 hover:text-white"
          >
            ×
          </button>
        </div>
      )}
      {open && (
        <FounderInviteModal
          cityName={cityName}
          busy={busy}
          error={error}
          onAccept={() => void accept()}
          onLater={() => {
            setOpen(false)
            setError(null)
          }}
        />
      )}
    </>
  )
}
