import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { getFirestore, type DocumentData, type DocumentReference, type QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { requireActive } from './userData'
import { isBotUid, requirePlayAccess } from './playAccess'
import { tierNow } from './entitlements'
import { takeRateLimit } from './rateLimits'
import { isPlayId, playIdOf } from './playIds'
import { storagePath } from './storagePath'
import { blockedFor } from './blockCore'
import {
  buildPreview,
  isLikeId,
  isLive,
  likeEntryOf,
  likeVisible,
  newLikeId,
  photoDelivery,
  playSource,
  previewAllowed,
  sparkSource,
  type LikeEntry,
  type LikeMode,
  type LikerPreview,
  type LikerState,
} from './likerPreviewCore'

// §4.A3 — anonymous likers. Who liked you used to reach your app as the
// like queue itself (users/{uid}/likeQueue/{likerUid | likerPlayId}, with a
// snapshot of the liker), and a uid opens the liker's public root doc. Now:
//
//   users/{uid}/likeQueue/{key}   unchanged, but server-only (firestore.rules);
//                                 each doc carries an opaque likeId (lk_…)
//   getLikes(mode)                the count, and — Spark+ / Elite — the list
//                                 by like id (likerPreviewCore LikeEntry)
//   getLikerPreview(likeId)       Spark+ / Elite: photo, first name, bio,
//                                 prompts — nothing else
//   likeBack(likeId)              (index.ts) resolves the like here
//   dismissLike(likeId)           "Not for me"
//
// The like id is random and stored on the queue doc — written by onLike, or
// given here the first time a doc without one is listed (likes from before
// §4.A3, bots' seeded likes), so old and new docs work side by side and the
// migration (scripts/migrate-a3-likes.mjs) only does ahead of time what this
// does on demand. A like id is looked up only in the caller's own queue.
//
// Hidden (not listed, counted or previewed): a liker who's deleted, gone,
// suspended or blocked either way — and, for a Play like, out of Play.

const db = () => getFirestore()
const queueOf = (uid: string) => db().collection(`users/${uid}/likeQueue`)
// The newest likes looked at per call — far above any real queue.
const MAX_QUEUE = 300
const TEN_MIN = 10 * 60 * 1000

const notAvailable = () => new HttpsError('not-found', "That like isn't available.")

function parseMode(data: unknown): LikeMode {
  return (data as Record<string, unknown> | null)?.mode === 'play' ? 'play' : 'spark'
}

function parseLikeId(data: unknown): string {
  const likeId = (data as Record<string, unknown> | null)?.likeId
  if (!isLikeId(likeId)) throw new HttpsError('invalid-argument', 'likeId required')
  return likeId
}

// The liker behind a queue doc. Spark docs are keyed by the liker's uid (a
// likerUid field on older ones); Play docs by their Play ID (F-062) — the
// account is looked up server-side.
interface Liker {
  uid: string | null
  playId: string | null
}

async function likersOf(docs: QueryDocumentSnapshot[], mode: LikeMode): Promise<Liker[]> {
  if (mode === 'spark') {
    return docs.map((d) => {
      const u: unknown = d.get('likerUid')
      return { uid: typeof u === 'string' && u ? u : d.id, playId: null }
    })
  }
  const playIds = docs.map((d) => {
    const p: unknown = d.get('likerPlayId')
    return isPlayId(p) ? p : isPlayId(d.id) ? d.id : null
  })
  const refs = [...new Set(playIds.filter((p): p is string => !!p))].map((p) => db().doc(`playIdOwners/${p}`))
  const owners = new Map<string, string>()
  if (refs.length) {
    for (const s of await db().getAll(...refs)) {
      const u: unknown = s.get('uid')
      if (typeof u === 'string' && u) owners.set(s.id, u)
    }
  }
  return playIds.map((p) => ({ uid: p ? (owners.get(p) ?? null) : null, playId: p }))
}

const playAccessNow = (internal: DocumentData | undefined, now: number): boolean => {
  if (internal?.playAccess !== true) return false
  const until = internal.playAccessUntil as { toMillis?: () => number } | number | null | undefined
  const ms = typeof until === 'number' ? until : until && typeof until.toMillis === 'function' ? until.toMillis() : null
  return ms === null || ms > now
}

// Each liker's state as `viewer` sees them, read in batches. Same tests as
// isSuspendedUid / blockedEitherWay / playStatus, without a read per like.
async function likerStates(viewer: string, likers: Liker[], mode: LikeMode): Promise<Map<string, LikerState>> {
  const uids = [...new Set(likers.map((l) => l.uid).filter((u): u is string => !!u && u !== viewer))]
  const out = new Map<string, LikerState>()
  if (!uids.length) return out
  const d = db()
  const [roots, internals, theirs, mine, plays] = await Promise.all([
    d.getAll(...uids.map((u) => d.doc(`users/${u}`))),
    d.getAll(...uids.map((u) => d.doc(`userInternal/${u}`))),
    d.getAll(...uids.map((u) => d.doc(`users/${u}/blockedUsers/${viewer}`))),
    d.getAll(...uids.map((u) => d.doc(`users/${viewer}/blockedUsers/${u}`))),
    mode === 'play'
      ? (() => {
          const ids = uids.map((u) => likers.find((l) => l.uid === u)?.playId ?? null)
          const refs = ids.filter((p): p is string => !!p).map((p) => d.doc(`playProfiles/${p}`))
          return refs.length ? d.getAll(...refs) : Promise.resolve([])
        })()
      : Promise.resolve([]),
  ])
  const playCopy = new Set(plays.filter((s) => s.exists).map((s) => s.id))
  const now = Date.now()
  uids.forEach((u, i) => {
    const root = roots[i].data()
    const internal = internals[i].data()
    const playId = likers.find((l) => l.uid === u)?.playId ?? null
    out.set(u, {
      exists: !!root,
      deleted: root?.isDeleted === true,
      suspended: internal?.isSuspended === true || root?.isSuspended === true,
      // H3: placed on the viewer, or by them in this mode.
      blocked: blockedFor(viewer, [theirs[i].data(), mine[i].data()], mode),
      playOk: isBotUid(u) || (playAccessNow(internal, now) && !!playId && playCopy.has(playId)),
    })
  })
  return out
}

// Gives every doc that has no like id one (in a transaction, so two calls at
// once agree on it) and returns each doc's id.
async function stampLikeIds(refs: DocumentReference[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!refs.length) return out
  await db().runTransaction(async (tx) => {
    out.clear()
    const snaps = await tx.getAll(...refs)
    for (const s of snaps) {
      if (!s.exists) continue
      const cur: unknown = s.get('likeId')
      if (isLikeId(cur)) {
        out.set(s.ref.path, cur)
      } else {
        const id = newLikeId()
        tx.update(s.ref, { likeId: id })
        out.set(s.ref.path, id)
      }
    }
  })
  return out
}

interface Listed {
  entry: LikeEntry
  raw: DocumentData
}

// The caller's likes in `mode` that may show: newest first, hidden ones out.
export async function listLikes(viewer: string, mode: LikeMode): Promise<Listed[]> {
  const snap = await queueOf(viewer).where('mode', '==', mode).get()
  const docs = snap.docs
    .sort((a, b) => Number(b.get('likedAt') ?? 0) - Number(a.get('likedAt') ?? 0))
    .slice(0, MAX_QUEUE)
  const likers = await likersOf(docs, mode)
  const states = await likerStates(viewer, likers, mode)
  const shown = docs.filter((_, i) => {
    const s = likers[i].uid ? states.get(likers[i].uid!) : undefined
    return !!s && likeVisible(s, mode)
  })
  const missing = shown.filter((d) => !isLikeId(d.get('likeId'))).map((d) => d.ref)
  const stamped = await stampLikeIds(missing)
  return shown
    .map((d) => {
      const id: unknown = d.get('likeId')
      const likeId = isLikeId(id) ? id : stamped.get(d.ref.path)
      return likeId ? { entry: likeEntryOf(likeId, d.id, d.data()), raw: d.data() } : null
    })
    .filter((x): x is Listed => x !== null)
}

export interface ResolvedLike {
  ref: DocumentReference
  data: DocumentData
  mode: LikeMode
  likerUid: string
  likerPlayId: string | null
  curated: boolean
}

// A like id → the like, from the caller's own queue only, and only while it
// may show. Anything else — malformed, someone else's, gone, hidden — is the
// same "not available".
export async function resolveLike(owner: string, likeId: string): Promise<ResolvedLike> {
  if (!isLikeId(likeId)) throw notAvailable()
  const doc = (await queueOf(owner).where('likeId', '==', likeId).limit(1).get()).docs[0]
  if (!doc) throw notAvailable()
  const mode: LikeMode = doc.get('mode') === 'play' ? 'play' : 'spark'
  const [liker] = await likersOf([doc], mode)
  if (!liker.uid || liker.uid === owner) throw notAvailable()
  const state = (await likerStates(owner, [liker], mode)).get(liker.uid)
  if (!state || !likeVisible(state, mode)) throw notAvailable()
  return {
    ref: doc.ref,
    data: doc.data(),
    mode,
    likerUid: liker.uid,
    likerPlayId: liker.playId,
    curated: likeEntryOf(likeId, doc.id, doc.data()).curated,
  }
}

// A pass from a profile page also takes them out of your queue (the app
// can't name the queue entry by uid any more). Called by recordSwipe.
export async function dismissQueuedLike(owner: string, target: string, mode: LikeMode): Promise<void> {
  const key = mode === 'play' ? await playIdOf(target) : target
  if (!key) return
  const ref = queueOf(owner).doc(key)
  if ((await ref.get()).exists) await ref.update({ dismissed: true, dismissedAt: Date.now() })
}

// ─── Photo ───────────────────────────────────────────────────────────────────

// sharp's types resolve to its ESM build under this CommonJS setup (see
// photoHashCore.ts), so it's typed by hand.
interface SharpChain {
  rotate(): SharpChain
  resize(w: number, h: number, o: { fit: 'inside'; withoutEnlargement: boolean }): SharpChain
  jpeg(o: { quality: number }): SharpChain
  toBuffer(): Promise<Buffer>
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp') as (input: Buffer) => SharpChain

const PREVIEW_EDGE = 720

// A stored photo's path names its owner (photos/{uid}/…, playPhotos/{playId}/…),
// and so does a signed URL to it — the preview carries the image itself,
// re-encoded (which also drops its metadata).
async function inlinePhoto(ref: string): Promise<string | null> {
  const loc = storagePath(ref)
  if (!loc) return null
  try {
    const [bytes] = await getStorage().bucket(loc.bucket).file(loc.path).download()
    const out = await sharp(bytes).rotate().resize(PREVIEW_EDGE, PREVIEW_EDGE, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer()
    return `data:image/jpeg;base64,${out.toString('base64')}`
  } catch (err) {
    logger.warn('getLikerPreview: photo unavailable', { message: err instanceof Error ? err.message : String(err) })
    return null
  }
}

// ─── Callables ───────────────────────────────────────────────────────────────

// "Who liked you": how many people (every plan), and the likes by id —
// Spark+ and Elite all of them, Free only curated profiles' (Stage C).
export const getLikes = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ count: number; likes: LikeEntry[] }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    await requireActive(uid)
    const mode = parseMode(request.data)
    if (mode === 'play') await requirePlayAccess(uid)
    await takeRateLimit(uid, 'likeList', { max: 120, windowMs: TEN_MIN })
    const [plan, listed] = await Promise.all([tierNow(uid), listLikes(uid, mode)])
    const now = Date.now()
    const current = listed.filter((l) => l.raw.isExpired !== true && (l.entry.expiresAt === null || l.entry.expiresAt > now))
    return {
      count: listed.filter((l) => !l.entry.curated && isLive(l.entry, l.raw, now)).length,
      likes: current.filter((l) => previewAllowed(plan, l.entry.curated)).map((l) => l.entry),
    }
  },
)

// One like's preview — what the viewer's plan allows, never who it is.
export const getLikerPreview = onCall(
  { timeoutSeconds: 30, memory: '512MiB', invoker: 'public' },
  async (request): Promise<{ preview: LikerPreview }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    await requireActive(uid)
    const likeId = parseLikeId(request.data)
    await takeRateLimit(uid, 'likerPreview', { max: 120, windowMs: TEN_MIN })
    const like = await resolveLike(uid, likeId)
    if (like.mode === 'play') await requirePlayAccess(uid)
    if (!previewAllowed(await tierNow(uid), like.curated)) {
      throw new HttpsError('permission-denied', 'Seeing who liked you needs Spark+.', { upgrade: 'spark_plus' })
    }
    // Spark: the public root doc. Play: the server-kept Play copy only
    // (F-062) — never the Spark profile.
    const src =
      like.mode === 'play'
        ? playSource((await db().doc(`playProfiles/${like.likerPlayId}`).get()).data() ?? {})
        : sparkSource((await db().doc(`users/${like.likerUid}`).get()).data() ?? {})
    const how = photoDelivery(src.photoRef, [like.likerUid, like.likerPlayId ?? ''], (r) => storagePath(r) !== null)
    const photo = how === 'inline' ? await inlinePhoto(src.photoRef!) : how === 'url' ? src.photoRef : null
    return { preview: buildPreview(like.mode, like.curated, src, photo) }
  },
)

// "Not for me": the like moves to Viewed.
export const dismissLike = onCall(
  { timeoutSeconds: 15, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    await requireActive(uid)
    const likeId = parseLikeId(request.data)
    await takeRateLimit(uid, 'likeDismiss', { max: 120, windowMs: TEN_MIN })
    const like = await resolveLike(uid, likeId)
    await like.ref.update({ dismissed: true, dismissedAt: Date.now() })
    return { success: true }
  },
)
