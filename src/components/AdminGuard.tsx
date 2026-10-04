import { useEffect, useState } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { isAdmin } from '../services/adminPhotos'

// Admin-only routes. Hides the pages from everyone else; the callables they
// use check isAdmin again server-side.
export default function AdminGuard() {
  const uid = useAuthStore((s) => s.user?.uid)
  const [result, setResult] = useState<{ uid: string; admin: boolean } | null>(null)

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    isAdmin(uid)
      .catch(() => false)
      .then((admin) => !cancelled && setResult({ uid, admin }))
    return () => {
      cancelled = true
    }
  }, [uid])

  if (!uid || result?.uid !== uid) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-white/15 border-t-white" />
      </div>
    )
  }
  return result.admin ? <Outlet /> : <Navigate to="/discover" replace />
}
