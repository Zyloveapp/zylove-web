import { isBotUid } from '../services/zyloveScore'

// Zylove's curated launch profiles (bots) are labelled wherever they appear —
// Explore cards, profiles, chats, likes — not only by the Explore banner
// (Stage C). They're removed from a city once its founding circle is full.
export default function CuratedBadge({ uid, className = '' }: { uid: string | null | undefined; className?: string }) {
  if (!uid || !isBotUid(uid)) return null
  return (
    <span
      title="A Zylove curated profile — shown while your city's community is being built, not a real member."
      className={`inline-block shrink-0 rounded-full border border-white/20 bg-white/10 px-2 py-0.5 text-xs font-semibold text-white/70 ${className}`}
    >
      Zylove curated
    </span>
  )
}
