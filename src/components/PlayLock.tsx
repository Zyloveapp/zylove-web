import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import { markPlayActive, onPlayLocked, playSessionExpired, trackPlayActivity } from '../services/playSession'
import PlayPinFlow from './PlayPinFlow'

// Covers Play with the PIN after 2 minutes without activity (on load, or on
// coming back to the tab). Unlocking drops the user back exactly where they
// were — no navigation, no transition. Cancelling leaves Play for Spark and
// goes to Explore, so the Play screen underneath isn't left showing.
export default function PlayLock() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const mode = useModeStore((s) => s.mode)
  const setMode = useModeStore((s) => s.setMode)
  const navigate = useNavigate()
  const [locked, setLocked] = useState(() => mode === 'play' && playSessionExpired())

  // Every way of locking (on load, on return, idle check) passes through here.
  useEffect(() => {
    if (locked) onPlayLocked()
  }, [locked])

  // Activity only counts while unlocked — taps on the PIN pad mustn't refresh
  // the timestamp, or a reload would skip the PIN.
  useEffect(() => {
    if (mode !== 'play') {
      setLocked(false)
      return
    }
    if (locked) return
    if (playSessionExpired()) {
      setLocked(true)
      return
    }
    return trackPlayActivity(() => {
      if (playSessionExpired()) setLocked(true)
    })
  }, [mode, locked])

  if (!locked || mode !== 'play' || !uid) return null
  return (
    <PlayPinFlow
      uid={uid}
      purpose="unlock"
      entrySubtitle="Your session timed out for privacy."
      onDone={() => {
        markPlayActive()
        setLocked(false)
      }}
      onCancel={() => {
        setLocked(false)
        setMode('spark')
        navigate('/discover', { replace: true })
      }}
    />
  )
}
