// "✦ Austin Founding Circle" — shown whenever isFounder is true, which covers
// auto-assigned founders (founderCohort set) and founder-code ones (no cohort).
export default function FounderBadge({ profile }: { profile: object }) {
  if ((profile as Record<string, unknown>).isFounder !== true) return null
  return (
    <span className="inline-block rounded-full border border-[#1B4FD8]/30 bg-[#1B4FD8]/20 px-3 py-1 text-xs font-semibold text-[#6B8FFF]">
      ✦ Austin Founding Circle
    </span>
  )
}
