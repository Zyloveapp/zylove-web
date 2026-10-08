import { onSchedule } from 'firebase-functions/v2/scheduler'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { categoriesOf } from './identity'
import { updateSearchName } from './searchName'
import { linkedAccounts } from './devices'
import { queueAdminAlert } from './adminAlerts'

// T&S Phase 1 — the risk score.
//
// Every account's behaviour signals (counts and timing, never content) are
// turned into features, compared with the account's own group (how they're
// matched + the mode they use) and with fixed rules for strong signals. The
// result, with a plain-English line for every point it scored, goes to
//   trustProfiles/{uid}  { score, reasons[], features, cohort, computedAt }
// and accounts at FLAG_AT or above get an open trustFlags/{uid} for review.
// Nothing here acts on an account: flag → admin review → graduated action.

export const FLAG_AT = 40
// A dismissed flag reopens only when the score rises this much, or a new
// kind of reason appears.
const REOPEN_DELTA = 15
// Groups smaller than this are compared by the fixed rules only.
export const MIN_COHORT = 30
// Closed flags (and their history) are kept this long after closing.
export const FLAG_RETENTION_MS = 2 * 365 * 24 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000
const db = () => getFirestore()

// ─── Features ────────────────────────────────────────────────────────────────

export interface Features {
  swipes7d: number
  swipesPerDay: number
  interestedRatio: number | null // likes / all swipes (≥ 30 swipes)
  medianSwipeSec: number | null // between consecutive swipes in a session (≥ 30 swipes)
  capHitDays30: number
  matchCount7d: number
  conversationsStarted: number
  conversationsReceived: number
  repliesGiven: number
  repliesReceived: number
  openerReplyRate: number | null // replies their openers got (≥ 5 openers)
  replyRate: number | null // how often they reply to openers (≥ 5)
  messagesSent: number
  unmatchAfterExchange: number
  duplicateOpenerRecipients: number // same opener, distinct people, 24h (last 7 days)
  duplicateOpenerSenders: number // same opener from N accounts, 24h (last 7 days)
  reporters90d: number // distinct reporters, last 90 days
  urgentReports90d: number
  blocksReceived: number
  accountAgeDays: number | null
  photoCount: number
  verified: boolean
  pendingPhotos: number
  photoRejections90d: number
  sharedDeviceAccounts: number
  sharedIpAccounts: number
  bannedDeviceMatch: boolean
  bannedIpMatch: boolean
  seriousReviewFlags: number // felt_unsafe / aggressive review-threshold hits
  otherReviewFlags: number
  behaviorRiskScore: number
  // T&S Phase 2
  scamTrapHits: number // scam-like messages to curated profiles (90 days)
  scamTrapKinds: string[]
  scamReporters30d: number // distinct people who reported them as a scam
  aiPhotos: number // photos that look AI-generated or deepfaked
  stolenPhotos: number // photos found elsewhere on the web
  countryMismatch: string | null // e.g. "IP: MX · phone: GB · city: US"
  // T&S Phase 3 (counts only)
  contactRequests24h: number // "Share contact" requests in the last day
  contactFastAfterUnlock7d: number // requests within 5 minutes of the chat unlocking, last 7 days
  // T&S Phase 5
  duplicatePhotoAccounts: number // other accounts sharing the same or a near-same photo
  blocklistPhoto: boolean // a photo matched one from an account banned for scams
}

export interface Reason {
  key: string
  points: number
  text: string
}

// Continuous features compared with the group: direction is which side is
// risky; only values beyond 2 robust standard deviations count.
const COHORT_FEATURES: { key: keyof Features; dir: 'high' | 'low'; weight: number; label: string }[] = [
  { key: 'swipesPerDay', dir: 'high', weight: 4, label: 'swipes a day' },
  { key: 'interestedRatio', dir: 'high', weight: 4, label: 'share of profiles liked' },
  { key: 'medianSwipeSec', dir: 'low', weight: 4, label: 'seconds per swipe' },
  { key: 'matchCount7d', dir: 'high', weight: 3, label: 'matches this week' },
  { key: 'openerReplyRate', dir: 'low', weight: 4, label: 'share of openers that get a reply' },
]

export interface Baseline {
  n: number
  stats: Partial<Record<keyof Features, { median: number; mad: number; n: number }>>
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function baselineOf(rows: Features[]): Baseline {
  const stats: Baseline['stats'] = {}
  for (const f of COHORT_FEATURES) {
    const xs = rows.map((r) => r[f.key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    if (xs.length < MIN_COHORT) continue
    const med = median(xs)
    stats[f.key] = { median: med, mad: median(xs.map((x) => Math.abs(x - med))), n: xs.length }
  }
  return { n: rows.length, stats }
}

const SCAM_KIND_TEXT: Record<string, string> = {
  code: 'asked for a code',
  giftCard: 'gift cards',
  moneyRequest: 'asked for money',
  crypto: 'crypto',
  offPlatform: 'another messenger',
  leavingApp: 'leaving the app',
  investmentPitch: 'investment pitch',
  overseas: 'overseas story',
  urgency: 'urgency',
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(v < 1 ? 2 : 1))
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// The score and its reasons. Pure — the nightly job, the on-demand rescore
// and the unit tests all use it.
export function scoreFeatures(f: Features, baseline: Baseline | null): { score: number; reasons: Reason[] } {
  const reasons: Reason[] = []
  const add = (key: string, points: number, text: string) => reasons.push({ key, points, text })

  // Strong signals.
  if (f.bannedDeviceMatch) add('banned_device', 60, 'Uses a device that a banned account used')
  if (f.bannedIpMatch && !f.bannedDeviceMatch) add('banned_ip', 15, 'Signed in from an address a banned account used (weak on its own)')
  if (f.sharedDeviceAccounts > 0) {
    add('shared_device', Math.min(45, 25 + 10 * (f.sharedDeviceAccounts - 1)), `Same device as ${plural(f.sharedDeviceAccounts, 'other account')}`)
  }
  if (f.sharedIpAccounts >= 2) add('shared_ip', 5, `Same network address as ${f.sharedIpAccounts} other accounts (weak)`)
  if (f.duplicateOpenerRecipients >= 5) {
    add('duplicate_opener', f.duplicateOpenerRecipients >= 10 ? 45 : 30, `Sent the same first message to ${f.duplicateOpenerRecipients} people within a day`)
  }
  if (f.duplicateOpenerSenders >= 3) add('shared_opener', 30, `The same first message was sent by ${f.duplicateOpenerSenders} accounts`)
  if (f.reporters90d >= 2) add('reports', f.reporters90d >= 3 ? 40 : 25, `Reported by ${f.reporters90d} different people in 90 days`)
  if (f.urgentReports90d >= 1) add('urgent_report', 20, `${plural(f.urgentReports90d, 'urgent report')} (felt unsafe / aggressive / child safety)`)
  if (f.seriousReviewFlags > 0) add('serious_reviews', 25 * f.seriousReviewFlags, 'Reviews crossed a "felt unsafe" or "aggressive" threshold')
  if (f.otherReviewFlags > 0) add('review_flags', 10 * f.otherReviewFlags, `${plural(f.otherReviewFlags, 'review category', 'review categories')} over the threshold`)

  // Weaker patterns.
  if (f.blocksReceived >= 3) add('blocks', 15, `Blocked by ${f.blocksReceived} people`)
  if (f.medianSwipeSec !== null && f.medianSwipeSec < 1.5 && f.swipes7d >= 100) {
    add('fast_swipes', 15, `Swipes in ${fmt(f.medianSwipeSec)}s on average (${f.swipes7d} this week)`)
  }
  if (f.interestedRatio !== null && f.interestedRatio > 0.95 && f.swipes7d >= 100) {
    add('likes_everyone', 15, `Liked ${Math.round(f.interestedRatio * 100)}% of ${f.swipes7d} profiles this week`)
  }
  if (f.openerReplyRate !== null && f.openerReplyRate < 0.1 && f.conversationsStarted >= 10) {
    add('ignored_openers', 15, `Only ${Math.round(f.openerReplyRate * 100)}% of ${f.conversationsStarted} openers got a reply`)
  }
  if (f.capHitDays30 >= 10) add('cap_hits', 5, `Hit the like/deck cap on ${f.capHitDays30} days this month`)
  if (f.accountAgeDays !== null && f.accountAgeDays < 2 && (f.conversationsStarted >= 15 || f.duplicateOpenerRecipients >= 5)) {
    add('new_and_busy', 15, `New account (${fmt(f.accountAgeDays)} days) that's already messaged ${f.conversationsStarted} people`)
  }
  if (f.unmatchAfterExchange >= 5) add('unmatches', 5, `Unmatched ${f.unmatchAfterExchange} people after talking`)
  if (f.photoRejections90d >= 2) add('photo_rejections', 10, `${f.photoRejections90d} photos rejected in moderation`)
  if (f.behaviorRiskScore > 60) add('behavior_risk', 10, `Older behaviour risk score ${Math.round(f.behaviorRiskScore)}`)

  // T&S Phase 2 — anti-scam.
  if (f.scamTrapHits > 0) {
    add('scam_trap', 45, `Sent ${plural(f.scamTrapHits, 'scam-like message')} to a curated profile (${f.scamTrapKinds.map((k) => SCAM_KIND_TEXT[k] ?? k).join(', ')})`)
  }
  if (f.scamReporters30d > 0) add('scam_reports', f.scamReporters30d >= 2 ? 40 : 20, `Reported as a scam by ${plural(f.scamReporters30d, 'person', 'people')} in 30 days`)
  if (f.aiPhotos > 0) add('ai_photo', 40, `${plural(f.aiPhotos, 'photo looks', 'photos look')} AI-generated or deepfaked`)
  if (f.stolenPhotos > 0) add('stolen_photo', 40, `${plural(f.stolenPhotos, 'photo appears', 'photos appear')} elsewhere on the web`)
  if (f.countryMismatch) add('country_mismatch', 40, `Signup countries disagree (${f.countryMismatch})`)

  // T&S Phase 3 — contact requests (weak on their own).
  if (f.contactRequests24h >= 5) add('contact_rush', 20, `Asked ${f.contactRequests24h} matches for contact details within a day`)
  // T&S Phase 5 — duplicate photos.
  if (f.blocklistPhoto) add('blocklist_photo', 60, 'A photo matches one from an account banned for scams')
  if (f.duplicatePhotoAccounts > 0) {
    add('duplicate_photo', 40, `Same or near-same photo as ${plural(f.duplicatePhotoAccounts, 'other account')}`)
  }
  if (f.contactFastAfterUnlock7d >= 3) add('contact_fast', 15, `Asked for contact details the moment a chat unlocked, ${f.contactFastAfterUnlock7d} times this week`)

  // Compared with their own group (only big enough groups).
  if (baseline && baseline.n >= MIN_COHORT) {
    for (const c of COHORT_FEATURES) {
      const v = f[c.key]
      const st = baseline.stats[c.key]
      if (typeof v !== 'number' || !st) continue
      const spread = 1.4826 * st.mad || Math.max(Math.abs(st.median) * 0.1, 1e-6)
      const z = (c.dir === 'high' ? v - st.median : st.median - v) / spread
      if (z <= 2) continue
      add(`cohort_${c.key}`, Math.round(c.weight * Math.min(4, z - 2)) || 1, `${fmt(v)} ${c.label} — far from their group's typical ${fmt(st.median)}`)
    }
  }

  reasons.sort((a, b) => b.points - a.points)
  return { score: Math.min(100, reasons.reduce((n, r) => n + r.points, 0)), reasons }
}

// The public reply band (T&S Phase 2): "Usually replies" once someone has
// had 5+ people write first and answered at least 70% of them. Nothing is
// shown below that — a band, never a percentage, and never a negative one.
export const REPLY_BAND_MIN_CONVERSATIONS = 5
export function replyBandOf(f: Pick<Features, 'conversationsReceived' | 'repliesGiven'>): 'usually' | null {
  if (f.conversationsReceived < REPLY_BAND_MIN_CONVERSATIONS) return null
  return f.repliesGiven / f.conversationsReceived >= 0.7 ? 'usually' : null
}

// ─── Loading ─────────────────────────────────────────────────────────────────

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const toMs = (v: unknown): number => (v instanceof Timestamp ? v.toMillis() : num(v))

export function cohortOf(root: DocumentData | undefined, profile: DocumentData | undefined, matching: DocumentData | undefined): string {
  const cat = categoriesOf(root?.genderIdentity, matching?.matchableAs ?? root?.matchableAs)[0] ?? 'everyone'
  const intent = profile?.intent ?? root?.intent
  return `${cat}|${intent === 'play' ? 'play' : 'spark'}`
}

interface SwipeAgg {
  times: number[]
  likes: number
  total: number
}

function swipeFeatures(agg: SwipeAgg | undefined): Pick<Features, 'swipes7d' | 'swipesPerDay' | 'interestedRatio' | 'medianSwipeSec'> {
  if (!agg || !agg.total) return { swipes7d: 0, swipesPerDay: 0, interestedRatio: null, medianSwipeSec: null }
  const t = [...agg.times].sort((a, b) => a - b)
  const gaps = t.slice(1).map((x, i) => (x - t[i]) / 1000).filter((g) => g > 0 && g < 600)
  return {
    swipes7d: agg.total,
    swipesPerDay: agg.total / 7,
    interestedRatio: agg.total >= 30 ? agg.likes / agg.total : null,
    medianSwipeSec: agg.total >= 30 && gaps.length ? median(gaps) : null,
  }
}

export function featuresOf(input: {
  root?: DocumentData
  internal?: DocumentData
  account?: DocumentData
  signals?: DocumentData
  swipes?: SwipeAgg
  reports?: { reporters: Set<string>; urgent: number; scamReporters30d?: Set<string> }
  reviewFlags?: string[]
  photoRejections90d?: number
  linked?: { via: string[] }[]
  now?: number
}): Features {
  const now = input.now ?? Date.now()
  const s = input.signals ?? {}
  const dup = (s.duplicateOpener ?? {}) as DocumentData
  const dupFresh = num(dup.at) > 0 && now - num(dup.at) < 7 * DAY_MS
  const created = num(input.internal?.accountCreatedAt)
  const caps = Array.isArray(s.capHitDays) ? (s.capHitDays as string[]) : []
  const monthAgo = new Date(now - 30 * DAY_MS).toISOString().slice(0, 10)
  const started = num(s.conversationsStarted)
  const received = num(s.conversationsReceived)
  const linked = input.linked ?? []
  return {
    ...swipeFeatures(input.swipes),
    capHitDays30: caps.filter((d) => d >= monthAgo).length,
    matchCount7d: num(s.matchCount7d),
    conversationsStarted: started,
    conversationsReceived: received,
    repliesGiven: num(s.repliesGiven),
    repliesReceived: num(s.repliesReceived),
    openerReplyRate: started >= 5 ? Math.min(1, num(s.repliesReceived) / started) : null,
    replyRate: received >= 5 ? Math.min(1, num(s.repliesGiven) / received) : null,
    messagesSent: num(s.messagesSent),
    unmatchAfterExchange: num(s.unmatchAfterExchangeCount),
    duplicateOpenerRecipients: dupFresh ? num(dup.recipients24h) : 0,
    duplicateOpenerSenders: dupFresh ? num(dup.senders24h) : 0,
    reporters90d: input.reports?.reporters.size ?? 0,
    urgentReports90d: input.reports?.urgent ?? 0,
    blocksReceived: num(s.receivedBlockCount),
    accountAgeDays: created > 0 ? (now - created) / DAY_MS : null,
    photoCount: Array.isArray(input.root?.photoURLs) ? input.root!.photoURLs.length : 0,
    verified: typeof input.root?.verificationStatus === 'string' && input.root.verificationStatus !== 'unverified',
    pendingPhotos: Array.isArray(input.account?.pendingPhotoURLs) ? input.account!.pendingPhotoURLs.length : 0,
    photoRejections90d: input.photoRejections90d ?? 0,
    sharedDeviceAccounts: linked.filter((l) => l.via.includes('device')).length,
    sharedIpAccounts: linked.filter((l) => !l.via.includes('device') && l.via.includes('ip')).length,
    bannedDeviceMatch: Boolean(s.bannedDeviceMatch),
    bannedIpMatch: Boolean(s.bannedIpMatch),
    seriousReviewFlags: (input.reviewFlags ?? []).filter((c) => c === 'felt_unsafe' || c === 'aggressive').length,
    otherReviewFlags: (input.reviewFlags ?? []).filter((c) => c !== 'felt_unsafe' && c !== 'aggressive').length,
    behaviorRiskScore: num(s.behaviorRiskScore),
    scamTrapHits: num((s.scamTrap as DocumentData | undefined)?.count),
    scamTrapKinds: Array.isArray((s.scamTrap as DocumentData | undefined)?.hits) ? ((s.scamTrap as DocumentData).hits as string[]) : [],
    scamReporters30d: input.reports?.scamReporters30d?.size ?? 0,
    aiPhotos: num((s.photoFlags as DocumentData | undefined)?.ai),
    stolenPhotos: num((s.photoFlags as DocumentData | undefined)?.stolen),
    countryMismatch: typeof (s.countryMismatch as DocumentData | undefined)?.text === 'string' ? (s.countryMismatch as DocumentData).text : null,
    ...contactFeatures(s.contactRequests as DocumentData | undefined, now),
    duplicatePhotoAccounts: num((s.duplicatePhotos as DocumentData | undefined)?.accounts),
    blocklistPhoto: Boolean(s.blocklistPhoto),
  }
}

function contactFeatures(c: DocumentData | undefined, now: number): Pick<Features, 'contactRequests24h' | 'contactFastAfterUnlock7d'> {
  const recent = Array.isArray(c?.recent) ? (c!.recent as { at: number; fast: boolean }[]) : []
  return {
    contactRequests24h: recent.filter((r) => now - num(r.at) < DAY_MS).length,
    contactFastAfterUnlock7d: recent.filter((r) => r.fast && now - num(r.at) < 7 * DAY_MS).length,
  }
}

// ─── Writing ─────────────────────────────────────────────────────────────────

async function save(uid: string, cohort: string, f: Features, result: { score: number; reasons: Reason[] }): Promise<boolean> {
  const now = Date.now()
  await db().doc(`trustProfiles/${uid}`).set({ score: result.score, reasons: result.reasons, features: f, cohort, computedAt: Timestamp.now() })
  const flagRef = db().doc(`trustFlags/${uid}`)
  const flag = (await flagRef.get()).data()
  if (flag?.status === 'open') {
    await flagRef.update({ score: result.score, reasons: result.reasons, updatedAt: FieldValue.serverTimestamp() })
    return true
  }
  if (result.score < FLAG_AT) return false
  if (flag && flag.status !== 'open') {
    const before = new Set(((flag.reasons ?? []) as Reason[]).map((r) => r.key))
    const newKind = result.reasons.some((r) => !before.has(r.key))
    if (result.score < num(flag.score) + REOPEN_DELTA && !newKind) return false
  }
  await flagRef.set({
    uid,
    status: 'open',
    score: result.score,
    reasons: result.reasons,
    cohort,
    openedAt: Timestamp.fromMillis(now),
    updatedAt: FieldValue.serverTimestamp(),
    previous: flag ? { status: flag.status, score: flag.score ?? null, closedAt: flag.closedAt ?? null } : null,
    expiresAt: null,
  })
  await queueAdminAlert('trustFlag', { subjectUid: uid, reasons: result.reasons.map((r) => r.key) })
  return true
}

const isBot = (uid: string) => /^(zbot|seed)-/.test(uid)

// Review-threshold hits (reviewQueue review_{uid}_{category}, reason
// "review_<category>"); the behaviour-risk entries count via behaviorRiskScore.
const reviewCategory = (r: DocumentData): string | null =>
  typeof r.reason === 'string' && r.reason.startsWith('review_') ? r.reason.slice('review_'.length) : null

async function reviewFlagsOf(uid: string): Promise<string[]> {
  const q = await db().collection('reviewQueue').where('reportedUid', '==', uid).get().catch(() => null)
  return (q?.docs ?? []).map((d) => reviewCategory(d.data())).filter((c): c is string => c !== null)
}

// One account, now (after a strong event), against the last nightly baselines.
export async function rescoreTrust(uid: string): Promise<{ score: number; flagged: boolean } | null> {
  if (isBot(uid)) return null
  const since = Date.now() - 7 * DAY_MS
  const [root, internal, account, profile, matching, signals, swipes, reports, reviewFlags, rejections, linked] = await Promise.all([
    db().doc(`users/${uid}`).get(),
    db().doc(`userInternal/${uid}`).get(),
    db().doc(`users/${uid}/private/account`).get(),
    db().doc(`users/${uid}/private/profile`).get(),
    db().doc(`users/${uid}/private/matching`).get(),
    db().doc(`behaviorSignals/${uid}`).get(),
    db().collection('swipes').where('swiperId', '==', uid).where('timestamp', '>=', Timestamp.fromMillis(since)).get().catch(() => null),
    db().collection('reports').where('reportedUid', '==', uid).get(),
    reviewFlagsOf(uid),
    db().collection('adminAudit').where('target', '==', uid).where('action', '==', 'photo.reject').get().catch(() => null),
    linkedAccounts(uid),
  ])
  if (!root.exists || root.data()?.isDeleted === true) return null
  const agg: SwipeAgg = { times: [], likes: 0, total: 0 }
  for (const d of swipes?.docs ?? []) {
    agg.total++
    agg.times.push(toMs(d.data().timestamp))
    if (d.data().action === 'like' || d.data().action === 'superlike') agg.likes++
  }
  const f = featuresOf({
    root: root.data(),
    internal: internal.data(),
    account: account.data(),
    signals: signals.data(),
    swipes: agg,
    reports: reportsAgg(reports.docs.map((d) => d.data())).get(uid),
    reviewFlags,
    photoRejections90d: (rejections?.docs ?? []).filter((d) => toMs(d.data().at) > Date.now() - 90 * DAY_MS).length,
    linked,
  })
  const cohort = cohortOf(root.data(), profile.data(), matching.data())
  const baseline = (await db().doc(`trustBaselines/${cohort.replace('|', '_')}`).get()).data() as Baseline | undefined
  const result = scoreFeatures(f, baseline ?? null)
  const flagged = await save(uid, cohort, f, result)
  return { score: result.score, flagged }
}

function reportsAgg(rows: DocumentData[], now = Date.now()): Map<string, { reporters: Set<string>; urgent: number; scamReporters30d: Set<string> }> {
  const out = new Map<string, { reporters: Set<string>; urgent: number; scamReporters30d: Set<string> }>()
  for (const r of rows) {
    const at = num(r.reportedAt) || toMs(r.updatedAt)
    if (!r.reportedUid || now - at > 90 * DAY_MS) continue
    const cur = out.get(r.reportedUid) ?? { reporters: new Set<string>(), urgent: 0, scamReporters30d: new Set<string>() }
    if (typeof r.reporterUid === 'string') cur.reporters.add(r.reporterUid)
    if (r.priority === 'urgent') cur.urgent++
    const cats = Array.isArray(r.categories) ? (r.categories as string[]) : [r.category]
    if (cats.includes('scam') && now - at <= 30 * DAY_MS && typeof r.reporterUid === 'string') cur.scamReporters30d.add(r.reporterUid)
    out.set(r.reportedUid, cur)
  }
  return out
}

// Every account, nightly: features, group baselines, scores, flags.
export const computeTrustScores = onSchedule(
  { schedule: '15 3 * * *', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '1GiB' },
  async () => {
    const now = Date.now()
    const since = Timestamp.fromMillis(now - 7 * DAY_MS)
    const [users, internals, signals, swipes, reports, reviewQueue, audits] = await Promise.all([
      db().collection('users').get(),
      db().collection('userInternal').get(),
      db().collection('behaviorSignals').get(),
      db().collection('swipes').where('timestamp', '>=', since).get(),
      db().collection('reports').get(),
      db().collection('reviewQueue').get(),
      db().collection('adminAudit').where('action', '==', 'photo.reject').get(),
    ])
    const byId = <T extends { id: string }>(docs: T[]) => new Map(docs.map((d) => [d.id, d]))
    const internalBy = byId(internals.docs)
    const signalBy = byId(signals.docs)
    const swipeBy = new Map<string, SwipeAgg>()
    for (const d of swipes.docs) {
      const s = d.data()
      const agg = swipeBy.get(s.swiperId) ?? { times: [], likes: 0, total: 0 }
      agg.total++
      agg.times.push(toMs(s.timestamp))
      if (s.action === 'like' || s.action === 'superlike') agg.likes++
      swipeBy.set(s.swiperId, agg)
    }
    const reportBy = reportsAgg(reports.docs.map((d) => d.data()), now)
    const reviewBy = new Map<string, string[]>()
    for (const d of reviewQueue.docs) {
      const r = d.data()
      const cat = reviewCategory(r)
      if (typeof r.reportedUid === 'string' && cat) reviewBy.set(r.reportedUid, [...(reviewBy.get(r.reportedUid) ?? []), cat])
    }
    const rejectBy = new Map<string, number>()
    for (const d of audits.docs) {
      const a = d.data()
      if (typeof a.target === 'string' && now - toMs(a.at) < 90 * DAY_MS) rejectBy.set(a.target, (rejectBy.get(a.target) ?? 0) + 1)
    }

    const live = users.docs.filter((u) => !isBot(u.id) && u.data().isDeleted !== true)
    // The admin directory's name index, kept current.
    await Promise.all(live.filter((u) => internalBy.get(u.id)?.data()?.searchName !== String(u.data().displayName ?? '').trim().toLowerCase()).map((u) => updateSearchName(u.id, u.data().displayName)))
    const rows: { uid: string; cohort: string; f: Features }[] = []
    for (const u of live) {
      const [account, profile, matching, linked] = await Promise.all([
        db().doc(`users/${u.id}/private/account`).get(),
        db().doc(`users/${u.id}/private/profile`).get(),
        db().doc(`users/${u.id}/private/matching`).get(),
        linkedAccounts(u.id),
      ])
      rows.push({
        uid: u.id,
        cohort: cohortOf(u.data(), profile.data(), matching.data()),
        f: featuresOf({
          root: u.data(),
          internal: internalBy.get(u.id)?.data(),
          account: account.data(),
          signals: signalBy.get(u.id)?.data(),
          swipes: swipeBy.get(u.id),
          reports: reportBy.get(u.id),
          reviewFlags: reviewBy.get(u.id),
          photoRejections90d: rejectBy.get(u.id) ?? 0,
          linked,
          now,
        }),
      })
    }
    const cohorts = new Map<string, Features[]>()
    for (const r of rows) cohorts.set(r.cohort, [...(cohorts.get(r.cohort) ?? []), r.f])
    const baselines = new Map<string, Baseline>()
    for (const [c, fs] of cohorts) {
      const b = baselineOf(fs)
      baselines.set(c, b)
      await db().doc(`trustBaselines/${c.replace('|', '_')}`).set({ ...b, cohort: c, computedAt: Timestamp.now() })
    }
    let flagged = 0
    for (const r of rows) if (await save(r.uid, r.cohort, r.f, scoreFeatures(r.f, baselines.get(r.cohort) ?? null))) flagged++
    // The public reply band, written only when it changes.
    const byUid = new Map(live.map((u) => [u.id, u.data()]))
    let bands = 0
    for (const r of rows) {
      const band = replyBandOf(r.f)
      if ((byUid.get(r.uid)?.replyBand ?? null) === band) continue
      await db().doc(`users/${r.uid}`).update({ replyBand: band ?? FieldValue.delete() })
      bands++
    }
    // Closed flags past retention go.
    const old = await db().collection('trustFlags').where('expiresAt', '<=', Timestamp.now()).get()
    await Promise.all(old.docs.map((d) => d.ref.delete()))
    logger.info('computeTrustScores', { accounts: rows.length, cohorts: cohorts.size, openFlags: flagged, expired: old.size, replyBands: bands })
  },
)

// Strong signals rescore at once rather than waiting for the night.
const IMMEDIATE = ['bannedDeviceMatch', 'bannedIpMatch', 'duplicateOpener', 'receivedBlockCount', 'scamTrap', 'photoFlags', 'countryMismatch', 'contactRequests', 'duplicatePhotos', 'blocklistPhoto'] as const
export const trustOnSignals = onDocumentWritten({ document: 'behaviorSignals/{uid}', memory: '256MiB', timeoutSeconds: 60 }, async (event) => {
  const before = event.data?.before.data() ?? {}
  const after = event.data?.after.data()
  if (!after) return
  const changed = IMMEDIATE.some((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))
  if (changed) await rescoreTrust(event.params.uid)
})
