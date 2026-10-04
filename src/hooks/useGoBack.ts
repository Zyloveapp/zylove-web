import { useNavigate } from 'react-router-dom'

// "← Back" that never leaves the app: steps back when there's an in-app page
// to return to (React Router keeps its history index in history.state.idx),
// otherwise — a deep link, a fresh PWA launch, a return from Stripe — goes
// to `fallback`.
export function useGoBack(fallback: string): () => void {
  const navigate = useNavigate()
  return () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate(fallback, { replace: true })
  }
}
