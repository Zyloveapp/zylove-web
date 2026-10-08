import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useModeStore, useBackLinkClass } from '../store/modeStore'
import { loadOwnProfile, type OwnProfile } from '../services/profile'
import { loadPlayExtras, loadPlayProfile, type PlayProfileData } from '../services/playProfile'
import { isPlayId } from '../services/playId'
import { subscribeAllMatches, type MatchEntry } from '../services/matches'
import { actionErrorMessage } from '../services/discover'
import { passFromProfile, sparkFromProfile } from '../services/sparks'
import ProfileSections from '../components/profile/ProfileSections'
import PlayProfileSections from '../components/profile/PlayProfileSections'
import CompatibilityBlock from '../components/discover/CompatibilityBlock'
import MatchOverlay, { type NewMatch } from '../components/discover/MatchOverlay'
import { playNameOf } from '../services/displayNames'

type Loaded = { uid: string; data: OwnProfile | null; play: PlayProfileData | null }

// Someone else's profile: the same layout as your own, minus the owner-only
// parts (edit, completeness, dealbreakers, Zylove Score). Linked people get a
// "Send a message" bar and a "Break the ice" opener; anyone else gets
// Send a Spark / Pass.
export default function ViewProfile() {
  const { uid: targetUid = '' } = useParams()
  // Keyed so moving between profiles starts fresh (no stale "Spark sent").
  return <ViewProfileFor key={targetUid} targetUid={targetUid} />
}

function ViewProfileFor({ targetUid }: { targetUid: string }) {
  const backLinkClass = useBackLinkClass()
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const mode = useModeStore((s) => s.mode)
  const navigate = useNavigate()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [matches, setMatches] = useState<MatchEntry[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [newMatch, setNewMatch] = useState<NewMatch | null>(null)

  useEffect(() => {
    if (!targetUid || targetUid === uid) return
    let cancelled = false
    // Play data only while in Play (Stage B: not fetched into a Spark
    // session, where the Play lock doesn't cover it). F-062: in Play a
    // profile is a Play ID and shows its public Play profile (and age) only —
    // never an account doc; a uid shows nothing in Play, a Play ID nothing in
    // Spark.
    const load: Promise<{ data: OwnProfile | null; play: PlayProfileData | null }> =
      mode === 'play'
        ? isPlayId(targetUid)
          ? Promise.all([loadPlayProfile(targetUid), loadPlayExtras(targetUid)]).then(([play, x]) => ({
              play,
              data: play
                ? { profile: { uid: targetUid, age: x.age ?? undefined, curated: x.curated }, bio: '', prompts: [], dealbreakers: [], seekingTraits: [], dynamicPrompt: null }
                : null,
            }))
          : Promise.resolve({ data: null, play: null })
        : isPlayId(targetUid)
          ? Promise.resolve({ data: null, play: null })
          : loadOwnProfile(targetUid)
              .catch(() => null)
              .then((data) => ({ data, play: null }))
    void load.then(({ data, play }) => {
      if (!cancelled) setLoaded({ uid: targetUid, data, play })
    })
    return () => {
      cancelled = true
    }
  }, [targetUid, uid, mode])

  // Every link; only one in the current mode counts (filtered below).
  useEffect(() => {
    if (!uid) return
    return subscribeAllMatches(uid, setMatches, () => setMatches([]))
  }, [uid])

  if (targetUid === uid) return <Navigate to="/profile" replace />

  const page = 'min-h-[calc(100dvh-7rem)] lg:min-h-[calc(100dvh-7.5rem)] bg-gray-950 text-white'
  const current = loaded?.uid === targetUid ? loaded : null
  if (!current || matches === null) {
    return (
      <div className={`flex items-center justify-center ${page}`}>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      </div>
    )
  }
  if (!current.data) {
    return (
      <div className={`flex flex-col items-center justify-center gap-3 px-4 ${page}`}>
        <p className="text-white/60">This profile isn't available.</p>
        <Link to="/matches" className="text-sm text-white/40 underline hover:text-white/60">
          {mode === 'play' ? 'Back to Chats' : 'Back to Links'}
        </Link>
      </div>
    )
  }

  const { profile, bio, prompts, dynamicPrompt } = current.data
  const play = current.play
  // The profile for the mode you're in — a link in the other mode never
  // shows here (mode sealing).
  const viewMode = mode
  const link = matches.find((m) => m.partnerUid === targetUid && !m.ended && m.mode === mode) ?? null
  const accent = viewMode === 'play' ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'

  // Play never falls back to the Spark profile (mode sealing).
  if (viewMode === 'play' && !play) {
    return (
      <div className={`flex flex-col items-center justify-center gap-3 px-4 ${page}`}>
        <p className="text-white/60">This person doesn't have a Play profile.</p>
        <Link to="/matches" className="text-sm text-white/40 underline hover:text-white/60">
          Back to Chats
        </Link>
      </div>
    )
  }

  const report = (
    <section>
      <CompatibilityBlock
        key={targetUid}
        profile={profile}
        mode={viewMode}
        autoReveal
        fullReport
        match={link ? { matchId: link.matchId } : undefined}
      />
    </section>
  )

  function goBack() {
    if (window.history.length > 1) navigate(-1)
    else navigate('/discover')
  }

  async function act(spark: boolean) {
    if (busy || !current?.data) return
    setBusy(true)
    setError(null)
    try {
      if (spark) {
        const result = await sparkFromProfile(uid, viewMode, current.data.profile)
        if (result.matched && result.matchId) {
          setNewMatch({
            matchId: result.matchId,
            theirUid: targetUid,
            theirName:
              (viewMode === 'play' ? playNameOf(play, current.data.profile) : current.data.profile.displayName) || 'Someone',
            // Play: their Play photo only.
            theirPhoto: (viewMode === 'play' ? play?.photoURLs[0] : current.data.profile.photoURLs?.[0]) ?? null,
            mode: viewMode,
          })
        } else {
          setSent(true)
        }
      } else {
        await passFromProfile(uid, viewMode, targetUid)
        goBack()
      }
    } catch (err) {
      setError(actionErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={page}>
      <div className="mx-auto max-w-xl space-y-8 px-4 pt-4 pb-8">
        <button type="button" onClick={goBack} className={`text-sm font-medium ${backLinkClass} hover:text-white`}>
          ← Back
        </button>
        {viewMode === 'play' && play ? (
          <PlayProfileSections profile={profile} play={play} afterHeader={report} />
        ) : (
          <ProfileSections
            profile={profile}
            bio={bio}
            prompts={prompts}
            dynamicPrompt={dynamicPrompt}
            nameFallback="Someone"
            afterHeader={report}
          />
        )}
      </div>

      {/* Sits above the mobile bottom nav (h-16). */}
      <div className="sticky bottom-16 border-t border-white/10 bg-gray-950 px-4 py-3">
        <div className="mx-auto max-w-xl">
          {error && <p className="mb-2 text-center text-sm text-red-400">{error}</p>}
          {link ? (
            <button
              type="button"
              onClick={() => navigate(`/chat/${link.matchId}`)}
              className={`w-full rounded-xl py-3 font-semibold text-white transition-opacity hover:opacity-90 ${accent}`}
            >
              💬 Send a message
            </button>
          ) : sent ? (
            <p className="py-3 text-center text-sm text-white/60">
              {viewMode === 'play' ? 'Flame sent 🔥' : 'Spark sent ✦'} — waiting on them.
            </p>
          ) : (
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => act(false)}
                disabled={busy}
                className="flex-1 rounded-xl border border-white/20 py-3 font-semibold text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
              >
                Pass
              </button>
              <button
                type="button"
                onClick={() => act(true)}
                disabled={busy}
                className={`flex-[2] rounded-xl py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50 ${accent}`}
              >
                {viewMode === 'play' ? '🔥 Send a Flame' : '✦ Send a Spark'}
              </button>
            </div>
          )}
        </div>
      </div>

      {newMatch && <MatchOverlay match={newMatch} onClose={() => setNewMatch(null)} />}
    </div>
  )
}
