import { Navigate } from 'react-router-dom'

// No landing page in the web app yet: "/" (also where a home-screen launch can
// start) goes straight to Discover, and AuthGuard routes signed-out or
// unfinished users to /login or onboarding from there.
export default function Home() {
  return <Navigate to="/discover" replace />
}
