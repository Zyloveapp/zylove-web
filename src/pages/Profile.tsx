import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { loadOwnProfile, profileCompleteness, type OwnProfile } from '../services/profile'
import VisibilityControl from '../components/profile/VisibilityControl'
import JustForYouCard from '../components/profile/JustForYouCard'
import ProfileReviewModal from '../components/profile/ProfileReviewModal'
import ProfileSections, { Pills, SectionHeading } from '../components/profile/ProfileSections'
import { dealbreakerLabel, seekingTraitLabel } from '../components/discover/labels'

function Completeness({ percent }: { percent: number }) {
  const hint =
    percent >= 90 ? '🎉 Fully complete!' : percent >= 50 ? 'Almost there!' : 'Keep going — more detail means better matches.'
  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="font-semibold text-white">Profile Completeness</h3>
        <span className="text-lg font-bold text-[#7C9BFF]">{percent}%</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-[#1B4FD8]" style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-2 text-sm text-white/50">{hint}</p>
    </section>
  )
}

type Loaded = { uid: string; data: OwnProfile | null }

// Your own Spark profile as matches see it, plus the owner-only extras:
// dealbreakers, completeness and visibility.
export default function Profile() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [showReview, setShowReview] = useState(false)
  // e.g. "✦ Profile refreshed." after Reimagine my profile. Read once, then
  // cleared from history so a reload doesn't show it again.
  const location = useLocation()
  const navigate = useNavigate()
  const [flash] = useState<unknown>(() => (location.state as { flash?: unknown } | null)?.flash)
  useEffect(() => {
    if (flash) navigate(location.pathname, { replace: true, state: null })
  }, [flash, navigate, location.pathname])

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    loadOwnProfile(uid)
      .catch(() => null)
      .then((data) => {
        if (!cancelled) setLoaded({ uid, data })
      })
    return () => {
      cancelled = true
    }
  }, [uid])

  const page = 'min-h-[calc(100dvh-7rem)] bg-gray-950 text-white'

  if (loaded?.uid !== uid) {
    return (
      <div className={`flex items-center justify-center ${page}`}>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      </div>
    )
  }
  if (!loaded.data) {
    return (
      <div className={`flex items-center justify-center px-4 ${page}`}>
        <p className="text-white/60">Couldn't load your profile.</p>
      </div>
    )
  }

  const own = loaded.data

  return (
    <div className={page}>
      <div className="mx-auto max-w-xl space-y-8 px-4 pt-6 pb-8">
        {typeof flash === 'string' && (
          <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-center text-sm text-emerald-300">
            {flash}
          </p>
        )}
        <ProfileSections
          profile={own.profile}
          bio={own.bio}
          prompts={own.prompts}
          dynamicPrompt={own.dynamicPrompt}
          nameFallback="You"
          lookingFor={
            (own.seekingTraits.length > 0 || own.dealbreakers.length > 0) && (
              <section>
                <SectionHeading>What I'm looking for</SectionHeading>
                {own.seekingTraits.length > 0 && (
                  <>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/40">Looking for</p>
                    <Pills items={own.seekingTraits.map(seekingTraitLabel)} tone="cobalt" />
                  </>
                )}
                {own.dealbreakers.length > 0 && (
                  <>
                    <p
                      className={`mb-2 text-xs font-semibold uppercase tracking-widest text-white/40 ${own.seekingTraits.length > 0 ? 'mt-4' : ''}`}
                    >
                      Deal breakers
                    </p>
                    <Pills items={own.dealbreakers.map((d) => `🚫 ${dealbreakerLabel(d)}`)} tone="red" />
                  </>
                )}
                <p className="mt-2 text-xs text-white/30">Only you can see this.</p>
              </section>
            )
          }
          promptsExtra={
            <JustForYouCard
              uid={uid}
              prompts={own.prompts}
              dynamicPrompt={own.dynamicPrompt}
              onSaved={(prompts, question) =>
                setLoaded((l) => (l?.data ? { ...l, data: { ...l.data, prompts, dynamicPrompt: question } } : l))
              }
            />
          }
        />

        <Completeness percent={profileCompleteness(own)} />
        <VisibilityControl />
      </div>

      {/* Sits above the mobile bottom nav (h-16); flush on desktop. */}
      <div className="sticky bottom-16 border-t border-white/10 bg-gray-950 px-4 py-3">
        <div className="mx-auto grid max-w-xl grid-cols-3 gap-2 text-sm leading-tight">
          <Link
            to="/profile/edit"
            className="flex items-center justify-center rounded-xl border border-[#1B4FD8] px-2 py-3 text-center font-semibold text-white transition-colors hover:bg-[#1B4FD8]/15"
          >
            ✏ Edit my profile
          </Link>
          <button
            type="button"
            onClick={() => setShowReview(true)}
            className="flex items-center justify-center rounded-xl border border-[#1B4FD8]/60 px-2 py-3 text-center font-semibold text-[#B4C6FF] transition-colors hover:bg-[#1B4FD8]/15"
          >
            ✦ How's my profile?
          </button>
          <Link
            to="/zylove-score"
            className="flex items-center justify-center rounded-xl border border-white/20 px-2 py-3 text-center font-semibold text-white/80 transition-colors hover:bg-white/10"
          >
            🛡 Zylove Score
          </Link>
        </div>
      </div>

      {showReview && <ProfileReviewModal onClose={() => setShowReview(false)} />}
    </div>
  )
}
