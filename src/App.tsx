import { useEffect } from 'react'
import { BrowserRouter, Navigate, Outlet, Routes, Route, useNavigate, useSearchParams } from 'react-router-dom'
import { doc, getDoc } from 'firebase/firestore'
import { db } from './services/firebase'
import { useAuthStore } from './store/authStore'
import { founderHeartbeat } from './services/founders'
import { loadPin } from './services/playPin'
import { isAdmin } from './services/adminPhotos'
import { resetVibeCheckForTesting } from './services/vibeCheck'
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
import KeyBackupGate from './components/KeyBackupGate'
import DeviceSync from './components/DeviceSync'
import Login from './pages/Login'
import Terms from './pages/public/Terms'
import Privacy from './pages/public/Privacy'
import SmsTerms from './pages/public/SmsTerms'
import Community from './pages/public/Community'
import Join from './pages/public/Join'
import Contact from './pages/public/Contact'
import Onboarding from './pages/Onboarding'
import PlayOnboarding from './pages/PlayOnboarding'
import PlayGate from './components/PlayGate'
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
import ClaimFounder from './pages/ClaimFounder'
import NotFound from './pages/NotFound'
import FounderMessages from './pages/FounderMessages'
import AdminMessages from './pages/admin/AdminMessages'
import AdminDeletions from './pages/admin/AdminDeletions'
import AdminCities from './pages/admin/AdminCities'
import AdminActivity from './pages/admin/AdminActivity'
import AdminReports from './pages/admin/AdminReports'
import AdminTrust from './pages/admin/AdminTrust'
import AdminLocker from './pages/admin/AdminLocker'
import AdminNotifications from './pages/admin/AdminNotifications'
import AdminContact from './pages/admin/AdminContact'
import AdminNotice from './components/AdminNotice'
import LegalUpdateNotice from './components/LegalUpdateNotice'
import { touchLastActive } from './services/adminActivity'
import { loadPrivateProfile } from './services/privateProfile'

// Protected pages share the nav. Leaves room for the mobile bottom bar.
// The start-up calls (PIN cache, last active, founder check) run once per user per page load.
const startupDone = new Set<string>()

// Chose the Play path in onboarding but never finished Play setup (left it,
// or the redirect didn't happen): send them back once per session.
const PLAY_SETUP_NUDGED = 'zylove_play_setup_nudged'

async function needsPlaySetup(uid: string): Promise<boolean> {
  try {
    if (sessionStorage.getItem(PLAY_SETUP_NUDGED) === uid) return false
  } catch {
    // No session storage — still check, at worst it nudges again.
  }
  const meta = await loadPrivateProfile(uid).catch(() => null)
  if (meta?.onboardingPath !== 'play') return false
  const play = await getDoc(doc(db, `users/${uid}/playProfile/data`)).catch(() => null)
  return play !== null && !play.exists()
}

declare global {
  interface Window {
    // Admin-only console helper for testing vibe checks.
    __resetVibeCheck?: (matchId: string) => void
  }
}

// Editing an existing Play profile (?edit=true) shows Play data, so it needs
// Play unlocked; a first-time Play onboarding has nothing to protect yet.
function PlayOnboardingRoute() {
  const [params] = useSearchParams()
  return params.get('edit') === 'true' ? (
    <PlayGate>
      <PlayOnboarding />
    </PlayGate>
  ) : (
    <PlayOnboarding />
  )
}

function AppLayout() {
  const uid = useAuthStore((s) => s.user?.uid)
  const navigate = useNavigate()

  // Admins: window.__resetVibeCheck('matchId') in DevTools.
  useEffect(() => {
    if (!uid) return
    let cancelled = false
    isAdmin(uid)
      .then((admin) => {
        if (cancelled || !admin) return
        window.__resetVibeCheck = (matchId: string) => {
          resetVibeCheckForTesting(matchId, uid)
            .then(() => console.info(`Vibe check reset for ${matchId} — reopen the chat.`))
            .catch((err: unknown) => console.error('Vibe check reset failed', err))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
      delete window.__resetVibeCheck
    }
  }, [uid])

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
  // Signed in and onboarded: let the server know an active founder is around
  // (keeps their spot; see founderActivity.ts). Never blocks or errors. The
  // location isn't touched here — only Explore's first-time gate and
  // Settings → Update location take it.
  useEffect(() => {
    if (!uid || startupDone.has(uid)) return
    startupDone.add(uid)
    // Pull the Play PIN into this browser's cache (Settings reads it sync).
    void loadPin(uid).catch(() => {})
    void touchLastActive(uid)
    void founderHeartbeat(uid)
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
      <KeyBackupGate />
      <DeviceSync />
      <AdminNotice />
      <LegalUpdateNotice />
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
        <Route path="/sms-terms" element={<SmsTerms />} />
        <Route path="/community" element={<Community />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/upgrade" element={<Upgrade />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route element={<AuthGuard />}>
          {/* Full-screen flow: no header or nav. */}
          <Route path="/play-onboarding" element={<PlayOnboardingRoute />} />
          <Route element={<PauseGuard />}>
            <Route element={<AppLayout />}>
              <Route path="/discover" element={<Discover />} />
              <Route path="/matches" element={<Links />} />
              <Route path="/sparks" element={<Sparks />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/profile/edit" element={<EditProfile />} />
              <Route
                path="/edit-play-profile"
                element={
                  <PlayGate>
                    <EditPlayProfile />
                  </PlayGate>
                }
              />
              <Route path="/profile/:uid" element={<ViewProfile />} />
              <Route path="/profile/go-deeper" element={<GoDeeper />} />
              <Route path="/zylove-score" element={<ZyloveScore />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/founder-messages" element={<FounderMessages />} />
              <Route path="/settings/report" element={<ReportPastConnection />} />
              <Route path="/settings/blocked" element={<BlockedUsers />} />
              <Route path="/settings/reviews" element={<ReviewHistory />} />
              <Route path="/chat/:matchId" element={<Chat />} />
              <Route path="/claim-founder" element={<ClaimFounder />} />
              <Route element={<AdminGuard />}>
                <Route path="/admin/photos" element={<AdminPhotos />} />
                <Route path="/admin/messages" element={<AdminMessages />} />
                <Route path="/admin/deletions" element={<AdminDeletions />} />
                <Route path="/admin/cities" element={<AdminCities />} />
                <Route path="/admin/activity" element={<AdminActivity />} />
                <Route path="/admin/reports" element={<AdminReports />} />
                <Route path="/admin/trust" element={<AdminTrust />} />
                <Route path="/admin/locker" element={<AdminLocker />} />
                <Route path="/admin/notifications" element={<AdminNotifications />} />
                <Route path="/admin/contact" element={<AdminContact />} />
                {/* Summary texts link to zylove.app/admin: the Admin section in Settings. */}
                <Route path="/admin" element={<Navigate to="/settings" replace />} />
              </Route>
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  )
}
