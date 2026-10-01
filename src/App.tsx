import { BrowserRouter, Outlet, Routes, Route } from 'react-router-dom'
import AuthGuard from './components/AuthGuard'
import PauseGuard from './components/PauseGuard'
import Header from './components/Header'
import Nav from './components/Nav'
import ReviewPrompter from './components/ReviewPrompter'
import Home from './pages/Home'
import Login from './pages/Login'
import Onboarding from './pages/Onboarding'
import Discover from './pages/Discover'
import Links from './pages/Links'
import Sparks from './pages/Sparks'
import Profile from './pages/Profile'
import EditProfile from './pages/EditProfile'
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
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route element={<AuthGuard />}>
          <Route element={<PauseGuard />}>
            <Route element={<AppLayout />}>
              <Route path="/discover" element={<Discover />} />
              <Route path="/matches" element={<Links />} />
              <Route path="/sparks" element={<Sparks />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/profile/edit" element={<EditProfile />} />
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
