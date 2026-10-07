// T&S Phase 2 — "Member since Oct 2026 · Usually replies", next to the
// Zylove Score. Both are written by the server: memberSince from Firebase
// Auth's account record (month only), replyBand nightly once someone has
// had 5+ people write first (computeTrustScores). Nothing shows without them.

function memberSinceLabel(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}$/.test(v)) return null
  const [y, m] = v.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export default function TrustLine({ profile, className = '' }: { profile: Record<string, unknown>; className?: string }) {
  const since = memberSinceLabel(profile.memberSince)
  const replies = profile.replyBand === 'usually'
  if (!since && !replies) return null
  return (
    <p className={`flex flex-wrap gap-x-3 gap-y-1 text-sm text-white/50 ${className}`}>
      {since && <span>🗓 Member since {since}</span>}
      {replies && <span>💬 Usually replies</span>}
    </p>
  )
}
