import { useEffect } from 'react'
import { useAuthStore } from '../store/authStore'
import { reportDevice } from '../services/device'

// T&S Phase 1: tells the server which device this session is on (hashed
// there; a safety signal). Renders nothing; never blocks the app.
export default function DeviceSync() {
  const uid = useAuthStore((s) => s.user?.uid) ?? null
  useEffect(() => {
    if (uid) reportDevice(uid).catch(() => {})
  }, [uid])
  return null
}
