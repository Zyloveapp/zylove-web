import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../services/firebase'
import { useAuthStore } from '../store/authStore'
import { toEntry, type MatchEntry } from '../services/matches'
import ChatView from '../components/chat/ChatView'

type Loaded = { matchId: string; match: MatchEntry | null }

// Standalone route for a single conversation (e.g. a shared /chat/:matchId link).
export default function Chat() {
  const { matchId = '' } = useParams()
  const navigate = useNavigate()
  // AuthGuard guarantees a signed-in user on this route.
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!uid || !matchId) return
    return onSnapshot(
      doc(db, 'matches', matchId),
      (snap) => setLoaded({ matchId, match: snap.exists() ? toEntry(snap.id, snap.data(), uid) : null }),
      () => setLoaded({ matchId, match: null }),
    )
  }, [uid, matchId])

  const container = 'h-[calc(100dvh-7rem)] lg:h-[calc(100dvh-7.5rem)] bg-gray-950'

  if (loaded?.matchId !== matchId) {
    return (
      <div className={`flex items-center justify-center ${container}`}>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      </div>
    )
  }

  if (!loaded.match) {
    return (
      <div className={`flex flex-col items-center justify-center gap-3 text-white ${container}`}>
        <p className="text-white/60">This conversation isn't available.</p>
        <Link to="/matches" className="text-sm text-white/40 underline hover:text-white/60">
          Back to Links
        </Link>
      </div>
    )
  }

  return (
    <div className={container}>
      <ChatView key={matchId} uid={uid} match={loaded.match} onBack={() => navigate('/matches')} />
    </div>
  )
}
