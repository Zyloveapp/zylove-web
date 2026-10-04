// "✦ Austin Founder", "✦ NYC Founder": the founderBadge set by
// assignFounderBadge. Founders from before city circles, and founder-code
// ones, have no founderBadge; they're all Austin.
function founderBadgeLabel(profile: object): string | null {
  const p = profile as Record<string, unknown>
  if (p.isFounder !== true) return null
  return typeof p.founderBadge === 'string' && p.founderBadge ? p.founderBadge : 'Austin Founder'
}

export default function FounderBadge({ profile }: { profile: object }) {
  const label = founderBadgeLabel(profile)
  if (!label) return null
  return (
    <span className="inline-block rounded-full border border-[#1B4FD8]/30 bg-[#1B4FD8]/20 px-3 py-1 text-xs font-semibold text-[#6B8FFF]">
      ✦ {label}
    </span>
  )
}
