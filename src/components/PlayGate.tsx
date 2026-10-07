import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import { markPlayActive, playSessionExpired } from '../services/playSession'
import PlayPinFlow from './PlayPinFlow'

// Play pages reached directly — a Play chat, Edit Play profile, editing the
// Play onboarding — from history, a link or a new tab, whatever mode the app
// is in (Stage B, F-050): nothing renders until Play is unlocked in this
// tab. Unlocking enters Play; cancelling goes to Explore. Once in Play,
// PlayLock handles the inactivity lock.
export default function PlayGate({ children }: { children: ReactNode }) {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const mode = useModeStore((s) => s.mode)
  const setMode = useModeStore((s) => s.setMode)
  const navigate = useNavigate()
  const [unlocked, setUnlocked] = useState(() => mode === 'play' && !playSessionExpired())

  if (unlocked && mode === 'play') return <>{children}</>
  if (!uid) return null
  return (
    <PlayPinFlow
      uid={uid}
      purpose="unlock"
      onDone={() => {
        markPlayActive()
        setMode('play')
        setUnlocked(true)
      }}
      onCancel={() => navigate('/discover', { replace: true })}
    />
  )
}
