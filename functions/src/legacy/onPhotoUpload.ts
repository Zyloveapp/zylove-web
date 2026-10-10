// functions/src/onPhotoUpload.ts
//
// Storage-triggered photo moderation. Fires on any object finalize under
// `photos/{uid}/spark/*` or `photos/{uid}/play/*`. Calls Sightengine to
// screen for nudity / gore / offensive content against per-mode limits
// (SPARK_LIMITS / PLAY_LIMITS), then either adds the photo's Storage path to the
// user's photoURLs (clean) or pendingPhotoURLs (flagged).
//
// PATH-AWARE: Spark photos write to the root user doc; Play photos write
// to the playProfile/data subcollection. Discovery reads root; Play UI
// reads playProfile.
//
// FAIL-CLOSED: any error during moderation (network, auth, malformed
// response) results in the photo being added to pendingPhotoURLs — never
// published silently to photoURLs on error.
//
// Secrets: SIGHTENGINE_API_USER + SIGHTENGINE_API_SECRET.
// Deploy: firebase deploy --only functions:onPhotoUpload

import * as admin from 'firebase-admin'
import { onObjectFinalized } from 'firebase-functions/v2/storage'
import { defineSecret } from 'firebase-functions/params'
import { queueAdminAlert } from '../adminAlerts'
import { LEGACY_RUNTIME } from './legacyOptions'
import { stripPhotoMetadata } from '../photoMetadata'
import { takeRateLimit } from '../rateLimits'
import { accountRef, internalRef } from '../userData'
import { recordPhotoSignal, takeSightengineBudget, webMatches } from '../photoChecks'
import { checkPhoto } from '../photoHashes'
import { photoHoldRef } from '../photoHolds'
import { photoPathForLog, redactPlayPaths } from '../logSafe'
import { isPlayPhotoRef } from '../storagePath'
import { uidOfPlayId } from '../playIds'

// Sightengine score limits per mode (flag when a score is above its limit).
// nudity-2.1 categories + gore-2.0 / offensive probabilities.
const SPARK_LIMITS = {
  sexual_activity: 0.4,
  sexual_display:  0.5,
  erotica:         0.6,
  very_suggestive: 0.7,
  gore:            0.5,
  offensive:       0.5,
}
const PLAY_LIMITS: typeof SPARK_LIMITS = {
  sexual_activity: 0.6,  // explicit acts still flagged
  sexual_display:  0.85, // nudity more permissive
  erotica:         0.9,  // artistic nudity passes
  very_suggestive: 0.95, // almost never flags
  gore:            0.5,  // never ok
  offensive:       0.6,
}

const sightengineUser = defineSecret('SIGHTENGINE_API_USER')
const sightengineSecret = defineSecret('SIGHTENGINE_API_SECRET')

export const onPhotoUpload = onObjectFinalized(
  { secrets: [sightengineUser, sightengineSecret], ...LEGACY_RUNTIME },
  async (event) => {
    const filePath = event.data.name
    if (!filePath) return

    // Profile photos only: photos/{uid}/spark/{file}, and (F-062) Play
    // photos under the Play ID — playPhotos/{playId}/{file}, the account
    // resolved here. (photos/{uid}/play/… is the shape before F-062; the
    // rules no longer let the app upload there.)
    const playUpload: boolean = isPlayPhotoRef(String(filePath))
    const isProfilePhoto =
      filePath.match(/^photos\/[^/]+\/spark\//) ||
      filePath.match(/^photos\/[^/]+\/play\//) ||
      playUpload
    if (!isProfilePhoto) return

    const owner = playUpload ? await uidOfPlayId(filePath.split('/')[1]) : filePath.split('/')[1]
    if (!owner) {
      await admin.storage().bucket(event.data.bucket).file(filePath).delete({ ignoreNotFound: true })
      return
    }
    const uid: string = owner

    // Determine target based on upload path — Spark writes to root user doc,
    // Play writes to the playProfile/data subcollection.
    const isPlayPhoto = playUpload || filePath.match(/^photos\/[^/]+\/play\//)

    // Server-side copies (scripts/migrate-stage1b.mjs moving photos to new
    // names) were moderated as originals; the rules stop clients setting this.
    if (event.data.metadata?.zyloveCopy === '1') return

    // No profile to attach it to (a deleted account, or one that never
    // finished onboarding — which saves the profile before any photo): the
    // upload is removed and logged, never queued as a "moderation error".
    const profile = await admin.firestore().doc(`users/${uid}`).get()
    if (!profile.exists || profile.get('isDeleted') === true) {
      console.warn(`[moderation] No profile for uid ${uid}; removed ${photoPathForLog(filePath)}`)
      await admin.storage().bucket(event.data.bucket).file(filePath).delete({ ignoreNotFound: true })
      return
    }

    // Stage B (F-054): every upload is a paid moderation call and may page
    // the admins — at most 30 a day per person, and 10 waiting for review.
    // Past either, the upload is removed unmoderated.
    const overLimit = await takeRateLimit(uid, 'photoUploads', { max: 30, windowMs: 24 * 60 * 60 * 1000 }).then(() => false, () => true)
    const waiting = ((await accountRef(uid).get()).data()?.pendingPhotoURLs ?? []) as unknown[]
    if (overLimit || (Array.isArray(waiting) && waiting.length >= 10)) {
      console.warn(`[moderation] Upload limit reached for uid ${uid}; removed ${photoPathForLog(filePath)}`)
      await admin.storage().bucket(event.data.bucket).file(filePath).delete({ ignoreNotFound: true })
      return
    }

    // Firestore stores the Storage path, never a URL (F-021): viewers get
    // short-lived signed URLs from getPhotoUrls (photoAccess.ts), which
    // checks they may see the photo.
    const bucket = admin.storage().bucket(event.data.bucket)
    const file = bucket.file(filePath)
    const photoRef = filePath

    const db = admin.firestore()
    const userRef = db.collection('users').doc(uid)
    const photoDocRef = isPlayPhoto
      ? userRef.collection('playProfile').doc('data')
      : userRef

    // Stage A: new bytes under a name that's still published can't come from
    // the app (only the server deletes photos now). Never serve them: the
    // name comes off the published list and the bytes are deleted.
    const published = (await photoDocRef.get()).data()?.photoURLs
    if (Array.isArray(published) && published.includes(photoRef)) {
      console.warn(`[moderation] Re-upload over a published photo refused for uid ${uid}`)
      await photoDocRef.update({ photoURLs: admin.firestore.FieldValue.arrayRemove(photoRef) })
      await file.delete({ ignoreNotFound: true })
      return
    }

    // Helper: append a pending entry + flip hasPendingPhotos:true on the root
    // user doc (the admin photo-review tool queries users where('hasPendingPhotos','==',true)).
    // For Spark, photoDocRef === userRef so the flag is set in one write. For
    // Play, the entry goes on the playProfile subdoc and the flag goes on root.
    // Pending photos of both modes live in users/{uid}/private/account
    // (owner-only; each entry carries its mode — F-031); the review-queue flag
    // is userInternal/{uid}.hasPendingPhotos (see ../userData.ts).
    async function flagPending(entry: Record<string, unknown>) {
      await accountRef(uid).set({ pendingPhotoURLs: admin.firestore.FieldValue.arrayUnion(entry) }, { merge: true })
      await internalRef(uid).set({ hasPendingPhotos: true }, { merge: true })
    }

    // Text the admins (adminAlerts.ts: batched, count + link only).
    const notifyAdmins = () => queueAdminAlert('photoReview', { subjectUid: uid })

    // Stage B (F-052): metadata (EXIF GPS and the like) is stripped before
    // anything else — moderation included — sees the photo. The cleaned file
    // replaces the upload, marked zyloveCopy so that save doesn't come back
    // through here. Anything that isn't a well-formed JPEG/PNG is removed.
    {
      const [raw] = await file.download()
      const clean = stripPhotoMetadata(raw)
      if (!clean) {
        console.warn(`[moderation] Unsupported or malformed photo removed for uid ${uid}: ${photoPathForLog(filePath)}`)
        await file.delete({ ignoreNotFound: true })
        return
      }
      if (clean.bytes.length !== raw.length) {
        await file.save(clean.bytes, { contentType: clean.contentType, resumable: false, metadata: { metadata: { zyloveCopy: '1' } } })
      } else if (event.data.contentType !== clean.contentType) {
        // Low (fresh-eyes review): the type the bytes really are, not the one
        // the uploader claimed (a metadata update — not a new upload event).
        await file.setMetadata({ contentType: clean.contentType })
      }
      // T&S Phase 5: its perceptual hash — a duplicate on another account
      // counts against whichever had it later (F-087); a match with a banned
      // scammer's photo holds it back.
      const hashed = await checkPhoto(uid, filePath, isPlayPhoto ? 'play' : 'spark', Buffer.from(clean.bytes)).catch((err: unknown) => {
        console.warn(`[photoHash] failed for uid ${uid}: ${redactPlayPaths(err instanceof Error ? err.message : String(err))}`)
        return null
      })
      if (hashed?.blocklisted) {
        // The match's ban context is stored now (the banned account's records
        // may be gone by the time someone reviews it) — server-only (F-071).
        await photoHoldRef(uid, photoRef).set({
          uid,
          url: photoRef,
          mode: isPlayPhoto ? 'play' : 'spark',
          kind: 'blocklist',
          match: hashed.blocklisted,
          more: hashed.blocklistMore,
          distance: hashed.blocklisted.distance,
          heldAt: admin.firestore.Timestamp.now(),
        })
        await flagPending({
          url: photoRef,
          mode: isPlayPhoto ? 'play' : 'spark',
          flaggedAt: admin.firestore.Timestamp.now(),
          reason: { blocklist: true },
          approved: false,
        })
        await notifyAdmins()
        console.warn(`[moderation] Photo matches the banned-scammer blocklist for uid ${uid}; held for review`)
        return
      }
    }

    try {
      // Call Sightengine moderation API via multipart-form upload of the
      // raw bytes. URL-based fetch was rejected with HTTP 400 — likely
      // due to signature/encoding fragility on long signed URLs. Posting
      // bytes directly avoids URL fetch + auth concerns entirely.
      const [bytes] = await file.download()
      const contentType = event.data.contentType ?? 'image/jpeg'
      const filename = filePath.split('/').pop() ?? 'photo.jpg'

      const form = new FormData()
      form.append('media', new Blob([new Uint8Array(bytes)], { type: contentType }), filename)
      // T&S Phase 2: genai + deepfake ride along (flag for review only).
      form.append('models', 'nudity-2.1,offensive,gore-2.0,faces,genai,deepfake')
      form.append('api_user', sightengineUser.value())
      form.append('api_secret', sightengineSecret.value())

      // F-124: the project's daily Sightengine budget; spent → held for review.
      if (!(await takeSightengineBudget())) throw new Error('sightengine_budget')
      const response = await fetch('https://api.sightengine.com/1.0/check.json', {
        method: 'POST',
        body: form,
      })
      if (!response.ok) {
        throw new Error(`sightengine_http_${response.status}`)
      }
      const result = (await response.json()) as any

      // T&S Phase 2: AI-generated / deepfake scores and where else on the
      // web this image appears. Review signals only — they never change the
      // moderation outcome below, and a failure here is just logged.
      await (async () => {
        const web = await webMatches(event.data.bucket, filePath, uid)
        const ai = typeof result.type?.ai_generated === 'number' ? result.type.ai_generated : null
        const deepfake = typeof result.type?.deepfake === 'number' ? result.type.deepfake : null
        await recordPhotoSignal(uid, { path: photoRef, ai, deepfake, web })
      })().catch((err: unknown) => console.warn(`[photoChecks] failed for uid ${uid}: ${redactPlayPaths(err instanceof Error ? err.message : String(err))}`))

      // First-photo face gate — first photo must clearly show a face
      const existingDoc = await photoDocRef.get()
      const existingPhotos: string[] = existingDoc.exists
        ? (existingDoc.data()?.photoURLs ?? [])
        : []
      const isFirstPhoto = existingPhotos.length === 0

      // The 'faces' model returns a top-level faces array; older 'face'
      // responses nested it, so both shapes are read.
      const faces: any[] = Array.isArray(result.faces) ? result.faces : (result.face?.faces ?? [])
      const hasFace = faces.length > 0

      if (isFirstPhoto && !hasFace) {
        await flagPending({
          url: photoRef,
          mode: isPlayPhoto ? 'play' : 'spark',
          flaggedAt: admin.firestore.Timestamp.now(),
          reason: { noFace: true },
          approved: false,
        })
        await notifyAdmins()
        console.warn(`[moderation] No face detected in first photo for uid ${uid}`)
        return
      }

      // Determine pass/fail against the mode's limits: Spark is stricter,
      // Play allows more nudity but never explicit acts or gore. A score
      // above its limit sends the photo to review.
      const limits = isPlayPhoto ? PLAY_LIMITS : SPARK_LIMITS
      const scores: Record<keyof typeof SPARK_LIMITS, number> = {
        sexual_activity: result.nudity?.sexual_activity ?? 0,
        sexual_display:  result.nudity?.sexual_display ?? 0,
        erotica:         result.nudity?.erotica ?? 0,
        very_suggestive: result.nudity?.very_suggestive ?? 0,
        gore:            result.gore?.prob ?? 0,
        offensive:       result.offensive?.prob ?? 0,
      }
      const exceeded = (Object.keys(limits) as (keyof typeof limits)[]).filter((k) => scores[k] > limits[k])
      const flagged = exceeded.length > 0

      if (flagged) {
        // Add to pendingPhotoURLs — hidden from Discover until approved.
        // F-081: kept server-side too (photoHolds), so it stays in review
        // whatever happens to the owner's list.
        const flaggedAt = admin.firestore.Timestamp.now()
        await photoHoldRef(uid, photoRef).set({
          uid,
          url: photoRef,
          mode: isPlayPhoto ? 'play' : 'spark',
          kind: 'content',
          reason: { ...scores, exceeded },
          heldAt: flaggedAt,
        })
        await flagPending({
          url: photoRef,
          mode: isPlayPhoto ? 'play' : 'spark',
          flaggedAt,
          reason: { ...scores, exceeded },
          approved: false,
        })
        await notifyAdmins()
        console.warn(`[moderation] Photo flagged for uid ${uid}: ${photoPathForLog(filePath)}`)
      } else {
        // Clean — add to photoURLs, visible immediately
        await photoDocRef.update({
          photoURLs: admin.firestore.FieldValue.arrayUnion(photoRef),
        })
      }
    } catch (e: any) {
      // Fail closed — any moderation failure treats the photo as flagged.
      // Trust-safety review decides manually. This prevents Sightengine
      // outages or malformed responses from silently bypassing moderation.
      await flagPending({
        url: photoRef,
        mode: isPlayPhoto ? 'play' : 'spark',
        flaggedAt: admin.firestore.Timestamp.now(),
        reason: { error: e?.message ?? 'moderation_error' },
        approved: false,
      })
      await notifyAdmins()
      console.warn(
        `[moderation] Sightengine error for uid ${uid}: ${redactPlayPaths(String(e?.message ?? e))}`,
      )
    }
  },
)
