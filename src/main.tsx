import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { onAuthStateChanged } from 'firebase/auth'
import './index.css'
import App from './App.tsx'
import { auth } from './services/firebase'
import { initKeysForUser } from './services/keys'
import { useAuthStore } from './store/authStore'
import { useModeStore } from './store/modeStore'
import { BANNER_DISMISSED_KEY, clearPlaySession } from './services/playSession'

onAuthStateChanged(auth, (user) => {
  const { setUser, loading, setLoading } = useAuthStore.getState()
  // Signed out: the next person at this browser starts in Spark, locked,
  // and sees Explore's transparency banner again.
  if (!user) {
    useModeStore.getState().setMode('spark')
    clearPlaySession()
    try {
      sessionStorage.removeItem(BANNER_DISMISSED_KEY)
    } catch {
      // Storage unavailable — nothing to clear.
    }
  }
  setUser(user)
  if (loading) setLoading(false)
  // Every signed-in web user gets a real keypair before they chat.
  if (user) initKeysForUser(user.uid).catch((err: unknown) => console.warn('Key setup failed', err))
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
