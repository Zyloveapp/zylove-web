import { BrowserRouter, Outlet, Routes, Route } from 'react-router-dom'
import AuthGuard from './components/AuthGuard'
import PauseGuard from './components/PauseGuard'
import Header from './components/Header'
import Nav from './components/Nav'
import ReviewPrompter from './components/ReviewPrompter'
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
import Chat from './pages/Chat'

// Protected pages share the nav. Leaves room for the mobile bottom bar.
function AppLayout() {
  return (
    <div className="min-h-screen bg-gray-950">
      <Header />
      <Nav />
      <div className="pb-16">
        <Outlet />
      </div>
      <ReviewPrompter />
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public: landing (signed-in users are sent to /discover) and static pages. */}
        <Route path="/" element={<Login />} />
        <Route path="/login" element={<Login />} />
        <Route path="/join" element={<Join />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/community" element={<Community />} />
        <Route path="/contact" element={<Contact />} />
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
              <Route path="/profile/:uid" element={<ViewProfile />} />
              <Route path="/profile/go-deeper" element={<GoDeeper />} />
              <Route path="/zylove-score" element={<ZyloveScore />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/chat/:matchId" element={<Chat />} />
            </Route>
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
