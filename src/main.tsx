import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { onAuthStateChanged } from 'firebase/auth'
import './index.css'
import App from './App.tsx'
import { auth } from './services/firebase'
import { useAuthStore } from './store/authStore'

onAuthStateChanged(auth, (user) => {
  const { setUser, loading, setLoading } = useAuthStore.getState()
  setUser(user)
  if (loading) setLoading(false)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
