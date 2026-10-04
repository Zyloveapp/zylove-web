import { useEffect, useState } from 'react'
import { BrowserRouter, Outlet, Routes, Route, useNavigate } from 'react-router-dom'
import { doc, getDoc } from 'firebase/firestore'
import { db } from './services/firebase'
import { useAuthStore } from './store/authStore'
import { refreshLocationIfStale } from './services/location'
import { claimFounderBadge, founderCheckDone } from './services/founders'
import { loadPin } from './services/playPin'
import FounderCelebration from './components/FounderCelebration'
import AuthGuard from './components/AuthGuard'
import AdminGuard from './components/AdminGuard'
import AdminPhotos from './pages/AdminPhotos'
import EditPlayProfile from './pages/EditPlayProfile'
import PauseGuard from './components/PauseGuard'
import Header from './components/Header'
import Nav from './components/Nav'
import ReviewPrompter from './components/ReviewPrompter'
import PlayLock from './components/PlayLock'
import TrialExpiry from './components/TrialExpiry'
import Login from './pages/Login'
import Terms from './pages/public/Terms'
import Privacy from './pages/public/Privacy'
import Community from './pages/public/Community'
import Join from './pages/public/Join'
import Contact from './pages/public/Contact'
import Onboarding from './pages/Onboarding'
import PlayOnboarding from './pages/PlayOnboarding'
import Discover from './pages/Discover'
import Links from './pages/Links'
import Sparks from './pages/Sparks'
import Profile from './pages/Profile'
import EditProfile from './pages/EditProfile'
import ViewProfile from './pages/ViewProfile'
import GoDeeper from './pages/GoDeeper'
import ZyloveScore from './pages/ZyloveScore'
import Settings from './pages/Settings'
import ReportPastConnection from './pages/ReportPastConnection'
import BlockedUsers from './pages/BlockedUsers'
import ReviewHistory from './pages/ReviewHistory'
import Upgrade from './pages/Upgrade'
import SubscriptionSync from './components/SubscriptionSync'
import Chat from './pages/Chat'

// Protected pages share the nav. Leaves room for the mobile bottom bar.
// Location (and the founder check) run once per user per page load.
const locationChecked = new Set<string>()
const CELEBRATION_MS = 1500

// Chose the Play path in onboarding but never finished Play setup (left it,
// or the redirect didn't happen): send them back once per session.
const PLAY_SETUP_NUDGED = 'zylove_play_setup_nudged'

async function needsPlaySetup(uid: string): Promise<boolean> {
  try {
    if (sessionStorage.getItem(PLAY_SETUP_NUDGED) === uid) return false
  } catch {
    // No session storage — still check, at worst it nudges again.
  }
  const user = await getDoc(doc(db, 'users', uid)).catch(() => null)
  if (user?.data()?.onboardingPath !== 'play') return false
  const play = await getDoc(doc(db, `users/${uid}/playProfile/data`)).catch(() => null)
  return play !== null && !play.exists()
}

function AppLayout() {
  const uid = useAuthStore((s) => s.user?.uid)
  const navigate = useNavigate()

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    needsPlaySetup(uid).then((needed) => {
      if (!needed || cancelled) return
      try {
        sessionStorage.setItem(PLAY_SETUP_NUDGED, uid)
      } catch {
        // ignore
      }
      navigate('/play-onboarding', { replace: true })
    })
    return () => {
      cancelled = true
    }
  }, [uid, navigate])
  const [founder, setFounder] = useState<{ number: number; cityName?: string } | null>(null)

  // Signed in and onboarded: refresh a missing or week-old location in the
  // background, then — once per user, for people who finished onboarding
  // before founder badges existed — check for a city founder badge.
  // Never blocks or errors.
  useEffect(() => {
    if (!uid || locationChecked.has(uid)) return
    locationChecked.add(uid)
    // Pull the Play PIN into this browser's cache (Settings reads it sync).
    void loadPin(uid)
    void (async () => {
      await refreshLocationIfStale(uid)
      if (founderCheckDone(uid)) return
      const result = await claimFounderBadge(uid)
      if (result?.eligible) {
        setFounder({ number: result.cohortNumber, cityName: result.cityName })
        setTimeout(() => setFounder(null), CELEBRATION_MS)
      }
    })()
  }, [uid])

  return (
    <div className="min-h-screen bg-gray-950">
      <Header />
      <Nav />
      <div className="pb-16">
        <Outlet />
      </div>
      <ReviewPrompter />
      <PlayLock />
      <TrialExpiry />
      {founder && <FounderCelebration number={founder.number} cityName={founder.cityName} />}
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <SubscriptionSync />
      <Routes>
        {/* Public: landing (signed-in users are sent to /discover) and static pages. */}
        <Route path="/" element={<Login />} />
        <Route path="/login" element={<Login />} />
        <Route path="/join" element={<Join />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/community" element={<Community />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/upgrade" element={<Upgrade />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route element={<AuthGuard />}>
          {/* Full-screen flow: no header or nav. */}
          <Route path="/play-onboarding" element={<PlayOnboarding />} />
          <Route element={<PauseGuard />}>
            <Route element={<AppLayout />}>
              <Route path="/discover" element={<Discover />} />
              <Route path="/matches" element={<Links />} />
              <Route path="/sparks" element={<Sparks />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/profile/edit" element={<EditProfile />} />
              <Route path="/edit-play-profile" element={<EditPlayProfile />} />
              <Route path="/profile/:uid" element={<ViewProfile />} />
              <Route path="/profile/go-deeper" element={<GoDeeper />} />
              <Route path="/zylove-score" element={<ZyloveScore />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/report" element={<ReportPastConnection />} />
              <Route path="/settings/blocked" element={<BlockedUsers />} />
              <Route path="/settings/reviews" element={<ReviewHistory />} />
              <Route path="/chat/:matchId" element={<Chat />} />
              <Route element={<AdminGuard />}>
                <Route path="/admin/photos" element={<AdminPhotos />} />
              </Route>
            </Route>
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
