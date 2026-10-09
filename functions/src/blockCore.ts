// Blocks — the decisions, kept free of Firestore so they're unit-tested
// (functions/test/blocks.test.ts). A block is a mirror pair of records,
// users/{a}/blockedUsers/{b} and users/{b}/blockedUsers/{a}, both naming who
// placed it (blockedBy) and the modes it was placed in (modes; the first one
// also in mode, for older readers).
//
// C1: a block belongs to whoever placed it. The person blocked can't block
// back over it (blockPair is then a no-op), so they can't take it over,
// lift it or end the chat that's kept for it.
//
// H3: a block you placed in one mode changes nothing you're shown in the
// other — otherwise blocking a uid and probing Play IDs (or the other way
// round) found the one "isn't available", linking the two. A block placed ON
// you holds in both modes: the person who blocked you stays out of reach
// everywhere. That leaves one narrow link (someone who blocked you in Spark
// is also unavailable to you in Play), which only they can create, once.
// Records without modes (older web blocks, mobile's, ones without a
// blockedBy) hold in both modes: they can't be placed on demand any more,
// so they can't be used to probe.

export type BlockMode = 'spark' | 'play'

export interface BlockRecord {
  blockedBy?: unknown
  mode?: unknown
  modes?: unknown
}

const isMode = (v: unknown): v is BlockMode => v === 'spark' || v === 'play'

// The modes a record covers; null: every mode (no modes recorded).
export function blockModes(rec: BlockRecord | undefined): BlockMode[] | null {
  if (!rec) return []
  if (Array.isArray(rec.modes)) {
    const modes = [...new Set(rec.modes.filter(isMode))]
    return modes.length ? modes : null
  }
  return isMode(rec.mode) ? [rec.mode] : null
}

// Whether this record changes what `viewer` gets about the other person in
// `mode`: always when it was placed on the viewer (or nobody's recorded);
// only in its own modes when the viewer placed it.
export function blockApplies(viewer: string, rec: BlockRecord | undefined, mode: BlockMode): boolean {
  if (!rec) return false
  if (rec.blockedBy !== viewer) return true
  const modes = blockModes(rec)
  return modes === null || modes.includes(mode)
}

// Either of the two mirror records (they normally agree; an older pair may
// have only one).
export function blockedFor(viewer: string, recs: (BlockRecord | undefined)[], mode: BlockMode): boolean {
  return recs.some((r) => blockApplies(viewer, r, mode))
}

// What blockPair does with the records already there (C1):
//   create  no block between them yet — both records are created
//   extend  the caller's own block, now in another mode too
//   same    the caller's own block already covers this mode
//   noop    a block placed by the other person (or by nobody recorded) —
//           nothing changes, and the caller is told it worked
export type BlockPlan = 'create' | 'extend' | 'same' | 'noop'

export function planBlock(caller: string, recs: (BlockRecord | undefined)[], mode: BlockMode): BlockPlan {
  const present = recs.filter((r): r is BlockRecord => !!r)
  if (!present.length) return 'create'
  if (present.some((r) => r.blockedBy !== caller)) return 'noop'
  const covered = present.map(blockModes)
  if (covered.some((m) => m === null)) return 'same'
  return covered.every((m) => m!.includes(mode)) ? 'same' : 'extend'
}

// What lifting the caller's block in `mode` leaves: 'delete' (nothing left)
// or the modes it still holds in.
export function afterLift(rec: BlockRecord | undefined, mode: BlockMode): 'delete' | BlockMode[] {
  const modes = blockModes(rec)
  if (modes === null) return 'delete'
  const rest = modes.filter((m) => m !== mode)
  return rest.length ? rest : 'delete'
}

// Explore state (exploreState/{uid}): `blocked` hides people in both modes
// (blocks placed on you, and older ones); spark.blocked / play.blocked those
// you blocked in that mode only.
export function hiddenInMode(state: Record<string, unknown> | undefined, mode: BlockMode): string[] {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const perMode = (state?.[mode] as Record<string, unknown> | undefined)?.blocked
  return [...list(state?.blocked), ...list(perMode)]
}

// ─── Kept read-only after a block (H5) ───────────────────────────────────────
// A block keeps the chat read-only for BOTH people for the report window
// (preservedFor, preservedUntil) — the person blocked keeps what was said to
// them, to report it with evidence, even when the other blocked first. Past
// the window, a chat still only blocked (not unmatched) goes back to being
// the blocker's alone, as before; a kept chat that was also unmatched is
// deleted, as every kept chat is.
export type PreservedExpiry = 'delete' | 'release'

export function preservedExpiry(m: { isBlocked?: unknown; unmatchedAt?: unknown } | undefined): PreservedExpiry {
  return m?.isBlocked === true && (m.unmatchedAt === undefined || m.unmatchedAt === null) ? 'release' : 'delete'
}
