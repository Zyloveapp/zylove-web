import { BrowserRouter, Outlet, Routes, Route } from 'react-router-dom'
import AuthGuard from './components/AuthGuard'
import PauseGuard from './components/PauseGuard'
import Nav from './components/Nav'
import Home from './pages/Home'
import Login from './pages/Login'
import Onboarding from './pages/Onboarding'
import Discover from './pages/Discover'
import Matches from './pages/Matches'
import Sparks from './pages/Sparks'
import Profile from './pages/Profile'
import Chat from './pages/Chat'

// Protected pages share the nav. Leaves room for the mobile bottom bar.
function AppLayout() {
  return (
    <div className="min-h-screen bg-gray-950">
      <Nav />
      <div className="pb-16 lg:pb-0">
        <Outlet />
      </div>
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
              <Route path="/matches" element={<Matches />} />
              <Route path="/sparks" element={<Sparks />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/chat/:matchId" element={<Chat />} />
            </Route>
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
