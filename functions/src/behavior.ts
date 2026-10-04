import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { countMessages, generationOf, participants, pastConnectionId } from './matchGeneration'
import { loadPlayName } from './playName'
import { purgeMatchContent } from './matchCleanup'

// Behavioral safety signals feeding behaviorRiskScore.
//
// Stored server-only in behaviorSignals/{uid} — not on users/{uid}, which any
// signed-in user can read and its owner can write: risk scores and block
// counts there would be public and self-resettable. Flags go to reviewQueue,
// never onto the user doc. Bot chats (zbot-/seed-, or isBot) are ignored.
//
// pastConnections/{matchId}_{generation} keeps names, dates and message
// counts (never messages) of matches that ended, for 90 days, so "Report a
// past connection" and reviews still work after the match doc and its
// messages are gone. Older records are keyed {matchId} alone. Server-only;
// read via getPastConnections.

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

// A Play connection's name is always the Play one — the snapshot may be an
// older one holding the Spark name.
function nameIn(match: DocumentData, uid: string): Promise<string> {
  return connectionMode(match) === 'play' ? loadPlayName(uid) : Promise.resolve(displayName(match, uid))
}

async function bump(uid: string, field: string): Promise<void> {
  await getFirestore()
    .collection(SIGNALS)
    .doc(uid)
    .set({ [field]: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
}

// Names, dates and message counts of one ended match generation, for
// "Report a past connection" and for reviewing it after the doc and its
// messages are gone (90 days). Never message content. until: the next
// generation's start when a re-match overwrote this one. Returns the
// per-person message counts.
async function recordPastConnection(
  matchId: string,
  match: DocumentData,
  endedAt: number,
  until: number | null,
  endedBy?: string,
): Promise<Record<string, number>> {
  const generation = generationOf(match)
  const users = participants(match)
  const counts = await countMessages(matchId, generation, until)
  const sentCounts = Object.fromEntries(users.map((u) => [u, counts.bySender[u] ?? 0]))
  await getFirestore()
    .collection(PAST)
    .doc(pastConnectionId(matchId, generation))
    .set({
      matchId,
      generation,
      users,
      names: Object.fromEntries(await Promise.all(users.map(async (u) => [u, await nameIn(match, u)]))),
      matchedAt: matchedAtOf(match),
      endedAt,
      mode: match.mode === 'play' ? 'play' : 'spark',
      messageCount: counts.total,
      sentCounts,
      ...(endedBy ? { endedBy } : {}),
    })
  return sentCounts
}

// ─── unmatchConnection ───────────────────────────────────────────────────────

// Web unmatch: ends the match for good, as mobile's does. Records the past
// connection first — so the exit review and "Report a past connection" work
// straight away — then deletes the match doc, which sets off the purge of its
// messages and photos (onMatchBehaviorUpdate → purgeMatchContent).
export const unmatchConnection = onCall(
  { timeoutSeconds: 60, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    const matchId = (request.data as { matchId?: unknown } | null)?.matchId
    if (typeof matchId !== 'string' || !matchId) throw new HttpsError('invalid-argument', 'matchId is required')
    const ref = getFirestore().collection('matches').doc(matchId)
    const match = (await ref.get()).data()
    if (!match) return { success: true } // already gone
    if (!participants(match).includes(uid)) throw new HttpsError('permission-denied', 'Not a participant in this match')
    if (!isBotMatch(match) && !match.unmatchedAt) await recordPastConnection(matchId, match, Date.now(), null, uid)
    await ref.delete()
    logger.info('unmatchConnection', { matchId })
    return { success: true }
  },
)

// ─── onMatchBehaviorUpdate ───────────────────────────────────────────────────

// One match's life, keyed by generation (see matchGeneration.ts):
//   created → match velocity for both people (and stamp matchGeneration if
//             the writer didn't, e.g. mobile's onLike)
//   blocked → block counts
//   ended   → pastConnections record (with message counts, since the
//             messages are about to go), fast-unmatch signal
//   deleted → purge its messages and chat photos (matchCleanup.ts)
// A match ends when unmatchedAt is set, the doc is deleted (mobile's
// unmatch), or a re-match overwrites it in place (mobile's onLike set()).
// An overwritten generation's content isn't purged here — clients already
// hide it (messages before the generation), and it goes with the doc's
// eventual delete, which purges everything older than any live generation.
export const onMatchBehaviorUpdate = onDocumentWritten(
  { document: 'matches/{matchId}', timeoutSeconds: 300, memory: '512MiB' },
  async (event) => {
    const before = event.data?.before.data()
    const after = event.data?.after.data()
    const { matchId } = event.params
    const db = getFirestore()
    const beforeGen = generationOf(before)
    const afterGen = generationOf(after)
    // Same id, new match: the old generation ended without a delete.
    const replaced = Boolean(before && after && beforeGen && afterGen && beforeGen !== afterGen)

    if (after && typeof after.matchGeneration !== 'number' && afterGen > 0) {
      await event.data?.after.ref.update({ matchGeneration: afterGen }).catch((err: unknown) =>
        logger.warn('onMatchBehaviorUpdate: matchGeneration stamp failed', {
          matchId,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    }

    if (before && !isBotMatch(before)) {
      const users = participants(before)

      // Blocked: one more block received / initiated.
      if (after && !replaced && after.isBlocked === true && before.isBlocked !== true) {
        const blocker: unknown = after.blockedBy
        const blocked = users.find((u) => u !== blocker)
        if (typeof blocker === 'string' && users.includes(blocker) && blocked) {
          await Promise.all([bump(blocked, 'receivedBlockCount'), bump(blocker, 'initiatedBlockCount')])
        }
      }

      // A delete after a soft unmatch (unmatchedAt) was already handled then.
      const unmatchedNow =
        (after === undefined && !before.unmatchedAt) || (after !== undefined && !replaced && Boolean(after.unmatchedAt) && !before.unmatchedAt)
      if (unmatchedNow || replaced) {
        const matchedAt = matchedAtOf(before)
        const endedAt = after && !replaced ? toMillis(after.unmatchedAt) || Date.now() : Date.now()
        // unmatchConnection records the end itself before deleting (so a
        // review can follow at once); reuse that record rather than recount.
        const recorded = after === undefined ? (await db.collection(PAST).doc(pastConnectionId(matchId, beforeGen)).get()).data() : undefined
        const sent: Record<string, number> =
          recorded && typeof recorded.sentCounts === 'object' && recorded.sentCounts !== null
            ? (recorded.sentCounts as Record<string, number>)
            : await recordPastConnection(matchId, before, endedAt, replaced ? afterGen : null)

        // Matched, talked, gone within a day — attributed to whoever ended it.
        if (unmatchedNow && matchedAt && endedAt - matchedAt < FAST_UNMATCH_MS && users.every((u) => num(sent[u]) > 0)) {
          let unmatcher: unknown = after?.unmatchedBy ?? recorded?.endedBy
          if (typeof unmatcher !== 'string') {
            const reason = await db.collection('unmatchReasons').where('matchId', '==', matchId).limit(1).get()
            unmatcher = reason.docs[0]?.data().reporterUid
          }
          if (typeof unmatcher === 'string' && users.includes(unmatcher)) await bump(unmatcher, 'fastUnmatchCount')
        }
      }
    }

    // Deleted: its messages and photos go, bot matches too. After the
    // record above, which counts them first.
    if (before && after === undefined) await purgeMatchContent(matchId, null)

    // Created (or re-created in place): count it for both people.
    if (after && (!before || replaced) && !isBotMatch(after)) {
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
// one noResponse for the silent side, once per match generation
// (behaviorChecks/{matchId}_{generation}; this generation's messages only).
async function sweepNoResponse(): Promise<number> {
  const db = getFirestore()
  const now = Date.now()
  const matches = await db.collection('matches').get()
  let counted = 0
  for (const m of matches.docs) {
    const match = m.data()
    const age = now - matchedAtOf(match)
    if (isBotMatch(match) || match.isBlocked === true || age < NO_RESPONSE_AFTER_MS || age > NO_RESPONSE_WINDOW_MS) continue
    const generation = generationOf(match)
    const checkRef = db.collection('behaviorChecks').doc(`${m.id}_${generation}`)
    if ((await checkRef.get()).exists) continue
    const users = participants(match)
    if (users.length !== 2) continue
    const { bySender } = await countMessages(m.id, generation)
    if (users.every((u) => !bySender[u])) continue // nobody's written yet; look again tomorrow
    const silent = users.filter((u) => !bySender[u])
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
  // Which match between these two (see matchGeneration.ts); 0 for records
  // kept before generations existed.
  generation: number
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

    // Keyed by match and generation: a pair that matched twice is listed
    // twice. A live match replaces its own ended-record twin.
    const byId = new Map<string, PastConnection>()
    const play = new Set<string>()
    for (const d of past.docs) {
      const p = d.data()
      const users = participants(p)
      const otherUid = users.find((u) => u !== uid)
      if (!otherUid || isBotUid(otherUid) || toMillis(p.matchedAt) < since) continue
      if (mode && connectionMode(p) !== mode) continue
      const name: unknown = p.names?.[otherUid]
      const matchId = typeof p.matchId === 'string' ? p.matchId : d.id
      const generation = num(p.generation)
      if (connectionMode(p) === 'play') play.add(pastConnectionId(matchId, generation))
      byId.set(pastConnectionId(matchId, generation), {
        matchId,
        generation,
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
      const generation = generationOf(m)
      if (connectionMode(m) === 'play') play.add(pastConnectionId(d.id, generation))
      else play.delete(pastConnectionId(d.id, generation))
      byId.set(pastConnectionId(d.id, generation), {
        matchId: d.id,
        generation,
        otherUid,
        name: displayName(m, otherUid),
        matchedAt: matchedAtOf(m),
        ended: m.isBlocked === true,
      })
    }
    // Play connections are named by the Play name: stored names and older
    // snapshots may hold the Spark one.
    await Promise.all(
      [...byId].filter(([id]) => play.has(id)).map(async ([, c]) => (c.name = await loadPlayName(c.otherUid))),
    )
    // A pre-generation record (0) duplicates any other entry for its match.
    const all = [...byId.values()]
    const connections = all.filter((c) => c.generation !== 0 || !all.some((o) => o.matchId === c.matchId && o.generation !== 0))
    return { connections: connections.sort((a, b) => b.matchedAt - a.matchedAt) }
  },
)
