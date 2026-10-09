import { useEffect, useState } from 'react'
import { subscribeAccountView } from '../services/subscription'
import { useNavigate } from 'react-router-dom'
import { parseThreadMeta, type FounderThreadMeta } from '../services/founderMessages'
import { claimFounderBadge, founderOffer, founderRefusalMessage, spotsRemaining, type FounderOffer } from '../services/founders'
import FounderInviteModal from './FounderInvite'
import FounderCelebration from './FounderCelebration'

const CELEBRATION_MS = 1500

type Loaded = { uid: string; isFounder: boolean; founderStatus: unknown; meta: FounderThreadMeta | null }

function Row({ title, subtitle, dot, onClick }: { title: string; subtitle: string; dot?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between gap-4 rounded-lg border-l-2 border-[#1B4FD8] bg-white/5 px-4 py-3 text-left transition-colors hover:bg-white/10"
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2 font-medium text-white">
          {title}
          {dot && <span className="h-2 w-2 rounded-full bg-[#E03131]" aria-label="Unread" />}
        </span>
        <span className="block truncate text-sm text-white/50">{subtitle}</span>
      </span>
      <span className="text-white/30" aria-hidden>
        ›
      </span>
    </button>
  )
}

// Settings → Founder (both modes). Founders get their line to Matthew;
// everyone else in a launch city with a spot open in their half gets the
// founder invitation.
export default function FounderSettingsSection({ uid }: { uid: string }) {
  const navigate = useNavigate()
  const [user, setUser] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!uid) return
    // The account view: the public doc plus private/account, where founder
    // status and the thread summary live (Stage B).
    return subscribeAccountView(
      uid,
      (d) => {
        setUser({ uid, isFounder: d.isFounder === true, founderStatus: d.founderStatus, meta: parseThreadMeta(d.founderThreadMeta) })
      },
      () => setUser(null),
    )
  }, [uid])

  if (user?.uid !== uid) return null
  const founder = user.isFounder && user.founderStatus !== 'revoked'
  if (!founder) return <BecomeFounder uid={uid} />

  const meta = user.meta
  return (
    <section className="space-y-2">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/40">Founder</h2>
      <Row title="✦ Message the Founder" subtitle="Share your thoughts directly with Matthew" onClick={() => navigate('/founder-messages')} />
      <Row
        title="Messages from the Founder"
        subtitle={meta?.lastMessagePreview || 'No messages yet'}
        dot={meta?.hasUnread === true}
        onClick={() => navigate('/founder-messages')}
      />
    </section>
  )
}

// Shown while the user's city and half have a spot; tapping opens the same
// invitation as onboarding.
function BecomeFounder({ uid }: { uid: string }) {
  const [offer, setOffer] = useState<{ uid: string; offer: FounderOffer; spots: number } | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [celebrate, setCelebrate] = useState<{ number: number; cityName: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const o = await founderOffer(uid, { ask: false })
      const spots = o ? await spotsRemaining(o.city.id, o.bucket).catch(() => 0) : 0
      if (!cancelled) setOffer(o && spots > 0 ? { uid, offer: o, spots } : null)
    })()
    return () => {
      cancelled = true
    }
  }, [uid])

  async function accept(o: FounderOffer) {
    setBusy(true)
    setError(null)
    const result = await claimFounderBadge(uid)
    setBusy(false)
    if (!result) return setError("Couldn't save your spot. Try again.")
    if (result.eligible) {
      setOpen(false)
      setCelebrate({ number: result.cohortNumber, cityName: result.cityName ?? o.city.name })
      // The snapshot flips this section to the founder rows.
      setTimeout(() => setCelebrate(null), CELEBRATION_MS)
      return
    }
    setError(founderRefusalMessage(result.reason))
  }

  if (celebrate) return <FounderCelebration number={celebrate.number} cityName={celebrate.cityName} />
  if (offer?.uid !== uid) return null
  const { offer: o, spots } = offer
  const half = o.bucket === 'women' ? "women's" : "men's"

  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/40">Founder</h2>
      <Row
        title="✦ Become a founder"
        subtitle={`${spots} ${half} ${spots === 1 ? 'spot' : 'spots'} remaining in ${o.city.name}`}
        onClick={() => setOpen(true)}
      />
      {open && (
        <FounderInviteModal
          cityName={o.city.name}
          busy={busy}
          error={error}
          onAccept={() => void accept(o)}
          onLater={() => {
            setOpen(false)
            setError(null)
          }}
        />
      )}
    </section>
  )
}
