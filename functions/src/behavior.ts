import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'

// Behavioral safety signals feeding behaviorRiskScore.
//
// Stored server-only in behaviorSignals/{uid} — not on users/{uid}, which any
// signed-in user can read and its owner can write: risk scores and block
// counts there would be public and self-resettable. Flags go to reviewQueue,
// never onto the user doc. Bot chats (zbot-/seed-, or isBot) are ignored.
//
// pastConnections/{matchId} keeps names and dates (no messages) of matches
// that ended, for 90 days, so "Report a past connection" still works after
// mobile's unmatch deletes the match doc. Server-only; read via
// getPastConnections.

const SIGNALS = 'behaviorSignals'
const PAST = 'pastConnections'
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const FAST_UNMATCH_MS = DAY_MS
const NO_RESPONSE_AFTER_MS = 48 * HOUR_MS
const NO_RESPONSE_WINDOW_MS = 14 * DAY_MS // stop re-checking silent matches after this
const RETENTION_MS = 90 * DAY_MS
const RECENT_MATCHES_KEPT = 50
const RISK_FLAG_AT = 60

function toMillis(v: unknown): number {
  if (typeof v === 'number') return v
  return v instanceof Timestamp ? v.toMillis() : 0
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function participants(match: DocumentData): string[] {
  const users: unknown = match.users ?? match.participants
  return Array.isArray(users) ? users.filter((u): u is string => typeof u === 'string') : []
}

const isBotUid = (uid: string) => uid.startsWith('zbot-') || uid.startsWith('seed-')

function isBotMatch(match: DocumentData): boolean {
  return match.isBot === true || participants(match).some(isBotUid)
}

function matchedAtOf(match: DocumentData): number {
  return toMillis(match.matchedAt) || toMillis(match.createdAt)
}

function displayName(match: DocumentData, uid: string): string {
  const name: unknown = match.participantSnapshots?.[uid]?.displayName
  return typeof name === 'string' && name ? name : 'Someone'
}

async function bump(uid: string, field: string): Promise<void> {
  await getFirestore()
    .collection(SIGNALS)
    .doc(uid)
    .set({ [field]: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
}

// Did each participant send at least one message? Messages outlive mobile's
// match delete, so this works for ended matches too.
async function sentCounts(matchId: string, users: string[]): Promise<number[]> {
  const messages = getFirestore().collection(`matches/${matchId}/messages`)
  return Promise.all(users.map(async (u) => (await messages.where('senderId', '==', u).count().get()).data().count))
}

// ─── onMatchBehaviorUpdate ───────────────────────────────────────────────────

// Match velocity on create, block rate on isBlocked, fast unmatches when a
// match ends (deleted by mobile's unmatch, or unmatchedAt set).
export const onMatchBehaviorUpdate = onDocumentWritten(
  { document: 'matches/{matchId}', timeoutSeconds: 60, memory: '256MiB' },
  async (event) => {
    const before = event.data?.before.data()
    const after = event.data?.after.data()
    const { matchId } = event.params
    const db = getFirestore()

    // Created: count it for both people.
    if (!before && after) {
      if (isBotMatch(after)) return
      const now = Date.now()
      await Promise.all(
        participants(after).map((uid) =>
          db.runTransaction(async (tx) => {
            const ref = db.collection(SIGNALS).doc(uid)
            const recent = ((await tx.get(ref)).data()?.recentMatchAt ?? []) as number[]
            const next = [...recent, now].slice(-RECENT_MATCHES_KEPT)
            tx.set(
              ref,
              {
                matchCount: FieldValue.increment(1),
                recentMatchAt: next,
                matchCount7d: next.filter((t) => now - t < 7 * DAY_MS).length,
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true },
            )
          }),
        ),
      )
      return
    }
    if (!before || isBotMatch(before)) return
    const users = participants(before)

    // Blocked: one more block received / initiated.
    if (after && after.isBlocked === true && before.isBlocked !== true) {
      const blocker: unknown = after.blockedBy
      const blocked = users.find((u) => u !== blocker)
      if (typeof blocker === 'string' && users.includes(blocker) && blocked) {
        await Promise.all([bump(blocked, 'receivedBlockCount'), bump(blocker, 'initiatedBlockCount')])
      }
    }

    const endedNow = after === undefined || (Boolean(after.unmatchedAt) && !before.unmatchedAt)
    if (!endedNow) return
    const matchedAt = matchedAtOf(before)
    const endedAt = after ? toMillis(after.unmatchedAt) || Date.now() : Date.now()

    // Keep names and dates for "Report a past connection" (90 days).
    await db
      .collection(PAST)
      .doc(matchId)
      .set({
        users,
        names: Object.fromEntries(users.map((u) => [u, displayName(before, u)])),
        matchedAt,
        endedAt,
        mode: before.mode === 'play' ? 'play' : 'spark',
      })

    // Matched, talked, gone within a day — attributed to whoever ended it.
    if (matchedAt && endedAt - matchedAt < FAST_UNMATCH_MS) {
      const counts = await sentCounts(matchId, users)
      if (counts.every((c) => c > 0)) {
        let unmatcher: unknown = after?.unmatchedBy
        if (typeof unmatcher !== 'string') {
          const reason = await db.collection('unmatchReasons').where('matchId', '==', matchId).limit(1).get()
          unmatcher = reason.docs[0]?.data().reporterUid
        }
        if (typeof unmatcher === 'string' && users.includes(unmatcher)) await bump(unmatcher, 'fastUnmatchCount')
      }
    }
  },
)

// ─── Vibe checks ─────────────────────────────────────────────────────────────

// Called by recordVibeRating: keeps the rated person's positive-vibe rate.
export async function recordVibeSignal(ratedUid: string, positive: boolean): Promise<void> {
  const db = getFirestore()
  const ref = db.collection(SIGNALS).doc(ratedUid)
  await db.runTransaction(async (tx) => {
    const data = (await tx.get(ref)).data() ?? {}
    const ratings = num(data.vibeRatings) + 1
    const positives = num(data.vibePositive) + (positive ? 1 : 0)
    tx.set(
      ref,
      { vibeRatings: ratings, vibePositive: positives, vibeCheckPositiveRate: positives / ratings, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    )
  })
}

// ─── Risk score ──────────────────────────────────────────────────────────────

// 0–100, higher = riskier. Ratios only count once there's a match history.
function riskScore(s: DocumentData, zyloveScore: number | null): number {
  const matches = num(s.matchCount)
  const blocks = num(s.receivedBlockCount)
  const fast = num(s.fastUnmatchCount)
  const silent = num(s.noResponseCount)
  let risk = 0
  if (blocks > 3) risk += 20
  if (fast > 5) risk += 15
  if (matches > 0 && blocks / matches > 0.3) risk += 25
  if (matches > 0 && fast / matches > 0.4) risk += 20
  if (matches > 0 && silent / matches > 0.5) risk += 10
  if (zyloveScore !== null && zyloveScore < 50) risk += 10
  return Math.min(100, risk)
}

// Recomputes one user's behaviorRiskScore; over 60 queues them for review.
export async function recomputeBehaviorRisk(uid: string): Promise<number> {
  const db = getFirestore()
  const ref = db.collection(SIGNALS).doc(uid)
  const [signals, score] = await Promise.all([ref.get(), db.doc(`users/${uid}/zyloveScore/current`).get()])
  const s = signals.data() ?? {}
  const scoreData = score.data()
  // Only a score built from real reviews counts, not the starting value.
  const zylove = scoreData && num(scoreData.reviewCount) > 0 && typeof scoreData.score === 'number' ? scoreData.score : null
  const risk = riskScore(s, zylove)
  const flagged = risk > RISK_FLAG_AT

  const now = Date.now()
  const recent = (Array.isArray(s.recentMatchAt) ? s.recentMatchAt : []) as number[]
  await ref.set(
    {
      behaviorRiskScore: risk,
      flaggedForReview: flagged,
      matchCount7d: recent.filter((t) => now - t < 7 * DAY_MS).length,
      riskComputedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
  if (flagged) {
    await db.collection('reviewQueue').doc(`risk_${uid}`).set(
      {
        reportedUid: uid,
        reason: 'behavior_risk',
        priority: risk >= 80 ? 'urgent' : 'normal',
        behaviorRiskScore: risk,
        signals: {
          matchCount: num(s.matchCount),
          receivedBlockCount: num(s.receivedBlockCount),
          fastUnmatchCount: num(s.fastUnmatchCount),
          noResponseCount: num(s.noResponseCount),
        },
        flaggedForReview: true,
        source: 'behavior',
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
  }
  return risk
}

// ─── Daily job ───────────────────────────────────────────────────────────────

// Matches 48h–14d old where one side wrote and the other never answered:
// one noResponse for the silent side, once per match (behaviorChecks).
async function sweepNoResponse(): Promise<number> {
  const db = getFirestore()
  const now = Date.now()
  const matches = await db.collection('matches').get()
  let counted = 0
  for (const m of matches.docs) {
    const match = m.data()
    const age = now - matchedAtOf(match)
    if (isBotMatch(match) || match.isBlocked === true || age < NO_RESPONSE_AFTER_MS || age > NO_RESPONSE_WINDOW_MS) continue
    const checkRef = db.collection('behaviorChecks').doc(m.id)
    if ((await checkRef.get()).exists) continue
    const users = participants(match)
    if (users.length !== 2) continue
    const counts = await sentCounts(m.id, users)
    if (counts.every((c) => c === 0)) continue // nobody's written yet; look again tomorrow
    const silent = users.filter((_, i) => counts[i] === 0)
    for (const uid of silent) await bump(uid, 'noResponseCount')
    counted += silent.length
    await checkRef.set({ checkedAt: FieldValue.serverTimestamp(), noResponse: silent })
  }
  return counted
}

async function purgePastConnections(): Promise<number> {
  const db = getFirestore()
  const old = await db.collection(PAST).where('endedAt', '<', Date.now() - RETENTION_MS).get()
  await Promise.all(old.docs.map((d) => d.ref.delete()))
  return old.size
}

// 2am Central: no-response sweep, past-connection retention, then every
// user's risk score.
export const computeBehaviorScore = onSchedule(
  { schedule: '0 2 * * *', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const noResponse = await sweepNoResponse()
    const purged = await purgePastConnections()
    const signals = await getFirestore().collection(SIGNALS).get()
    let flagged = 0
    for (const d of signals.docs) {
      if ((await recomputeBehaviorRisk(d.id)) > RISK_FLAG_AT) flagged++
    }
    logger.info('computeBehaviorScore', { users: signals.size, flagged, noResponse, purged })
  },
)

// ─── Past connections ────────────────────────────────────────────────────────

interface PastConnection {
  matchId: string
  otherUid: string
  name: string
  matchedAt: number
  ended: boolean
}

// Everyone the caller matched with in the last 90 days — current matches and
// ended ones — as names and dates only, newest first. Bots are left out.
// 'play' (or legacy 'entanglement') is Play; anything else, including a
// missing mode on older matches, is Spark.
export function connectionMode(m: { mode?: unknown } | undefined): 'spark' | 'play' {
  return m?.mode === 'play' || m?.mode === 'entanglement' ? 'play' : 'spark'
}

// Optional { mode }: only that mode's connections. Without it, all of them.
function requestedMode(data: unknown): 'spark' | 'play' | null {
  const mode = (data as { mode?: unknown } | null)?.mode
  return mode === 'spark' || mode === 'play' ? mode : null
}

export const getPastConnections = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ connections: PastConnection[] }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    const mode = requestedMode(request.data)
    const db = getFirestore()
    const since = Date.now() - RETENTION_MS
    const [live, past] = await Promise.all([
      db.collection('matches').where('users', 'array-contains', uid).get(),
      db.collection(PAST).where('users', 'array-contains', uid).get(),
    ])

    const byId = new Map<string, PastConnection>()
    for (const d of past.docs) {
      const p = d.data()
      const users = participants(p)
      const otherUid = users.find((u) => u !== uid)
      if (!otherUid || isBotUid(otherUid) || toMillis(p.matchedAt) < since) continue
      if (mode && connectionMode(p) !== mode) continue
      const name: unknown = p.names?.[otherUid]
      byId.set(d.id, {
        matchId: d.id,
        otherUid,
        name: typeof name === 'string' ? name : 'Someone',
        matchedAt: toMillis(p.matchedAt),
        ended: true,
      })
    }
    for (const d of live.docs) {
      const m = d.data()
      const otherUid = participants(m).find((u) => u !== uid)
      if (!otherUid || isBotMatch(m) || matchedAtOf(m) < since) continue
      if (mode && connectionMode(m) !== mode) continue
      byId.set(d.id, {
        matchId: d.id,
        otherUid,
        name: displayName(m, otherUid),
        matchedAt: matchedAtOf(m),
        ended: m.isBlocked === true,
      })
    }
    return { connections: [...byId.values()].sort((a, b) => b.matchedAt - a.matchedAt) }
  },
)
