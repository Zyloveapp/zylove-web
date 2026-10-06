// functions/src/onPhotoUpload.ts
//
// Storage-triggered photo moderation. Fires on any object finalize under
// `photos/{uid}/spark/*` or `photos/{uid}/play/*`. Calls Sightengine to
// screen for nudity / gore / offensive content against per-mode limits
// (SPARK_LIMITS / PLAY_LIMITS), then either adds the URL to the user's
// photoURLs (clean) or pendingPhotoURLs (flagged).
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
import { sendPush } from './notifications'
import { LEGACY_RUNTIME } from './legacyOptions'
import { accountRef, internalRef } from '../userData'

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

    // Profile photos only — spark and play paths
    const isProfilePhoto =
      filePath.match(/^photos\/[^/]+\/spark\//) ||
      filePath.match(/^photos\/[^/]+\/play\//)
    if (!isProfilePhoto) return

    // Extract uid from path: photos/{uid}/spark/{filename}
    const uid = filePath.split('/')[1]
    if (!uid) return

    // Determine target based on upload path — Spark writes to root user doc,
    // Play writes to the playProfile/data subcollection.
    const isPlayPhoto = filePath.match(/^photos\/[^/]+\/play\//)

    // Get a long-lived signed URL for both Sightengine's fetch and the
    // Firestore write. One URL, one getSignedUrl call — the URL carries a
    // signature so <Image> tags can render it without auth, and Sightengine
    // can fetch the bytes without needing bucket-public permissions.
    const bucket = admin.storage().bucket(event.data.bucket)
    const file = bucket.file(filePath)
    const [storageUrl] = await file.getSignedUrl({
      action: 'read',
      expires: '03-01-2500', // effectively permanent for stored URLs
    })

    const db = admin.firestore()
    const userRef = db.collection('users').doc(uid)
    const photoDocRef = isPlayPhoto
      ? userRef.collection('playProfile').doc('data')
      : userRef

    // Helper: append a pending entry + flip hasPendingPhotos:true on the root
    // user doc (the admin photo-review tool queries users where('hasPendingPhotos','==',true)).
    // For Spark, photoDocRef === userRef so the flag is set in one write. For
    // Play, the entry goes on the playProfile subdoc and the flag goes on root.
    // Stage 1a: Spark pending photos live in users/{uid}/private/account
    // (owner-only), Play ones stay on playProfile/data; the review-queue flag
    // is userInternal/{uid}.hasPendingPhotos (see ../userData.ts).
    async function flagPending(entry: Record<string, unknown>) {
      if (isPlayPhoto) {
        await photoDocRef.update({
          pendingPhotoURLs: admin.firestore.FieldValue.arrayUnion(entry),
        })
      } else {
        await accountRef(uid).set({ pendingPhotoURLs: admin.firestore.FieldValue.arrayUnion(entry) }, { merge: true })
      }
      await internalRef(uid).set({ hasPendingPhotos: true }, { merge: true })
    }

    // Push-notify all admins so flagged uploads don't sit unseen in the
    // review queue. Uses shared sendPush helper which swallows fetch errors.
    async function notifyAdmins(displayName: string, photoUrl: string) {
      try {
        // Admins: userInternal/{uid}.admin (mirror of the auth claim).
        const adminSnap = await db.collection('userInternal')
          .where('admin', '==', true)
          .get()

        if (adminSnap.empty) return

        const tokens: string[] = adminSnap.docs
          .map(d => d.data().expoPushToken)
          .filter((t: unknown): t is string => typeof t === 'string' && t.length > 0)

        await sendPush(
          tokens,
          '📸 Photo needs review',
          `${displayName || 'A user'} uploaded a photo that needs approval`,
          { screen: 'admin/photos', photoUrl },
        )
      } catch (e) {
        console.error('[onPhotoUpload] Admin notify failed:', e)
      }
    }

    // Fetch user doc once up-front for displayName in admin notifications.
    // Used by all three flag paths (no-face, nudity/gore/offensive, error).
    const userDoc = (await userRef.get()).data() ?? {}

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
      form.append('models', 'nudity-2.1,offensive,gore-2.0,faces')
      form.append('api_user', sightengineUser.value())
      form.append('api_secret', sightengineSecret.value())

      const response = await fetch('https://api.sightengine.com/1.0/check.json', {
        method: 'POST',
        body: form,
      })
      if (!response.ok) {
        throw new Error(`sightengine_http_${response.status}`)
      }
      const result = (await response.json()) as any

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
          url: storageUrl,
          mode: isPlayPhoto ? 'play' : 'spark',
          flaggedAt: admin.firestore.Timestamp.now(),
          reason: { noFace: true },
          approved: false,
        })
        await notifyAdmins(userDoc.displayName ?? '', storageUrl)
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
        // Add to pendingPhotoURLs — hidden from Discover until approved
        await flagPending({
          url: storageUrl,
          mode: isPlayPhoto ? 'play' : 'spark',
          flaggedAt: admin.firestore.Timestamp.now(),
          reason: { ...scores, exceeded },
          approved: false,
        })
        await notifyAdmins(userDoc.displayName ?? '', storageUrl)
        console.warn(`[moderation] Photo flagged for uid ${uid}: ${filePath}`)
      } else {
        // Clean — add to photoURLs, visible immediately
        await photoDocRef.update({
          photoURLs: admin.firestore.FieldValue.arrayUnion(storageUrl),
        })
      }
    } catch (e: any) {
      // Fail closed — any moderation failure treats the photo as flagged.
      // Trust-safety review decides manually. This prevents Sightengine
      // outages or malformed responses from silently bypassing moderation.
      await flagPending({
        url: storageUrl,
        mode: isPlayPhoto ? 'play' : 'spark',
        flaggedAt: admin.firestore.Timestamp.now(),
        reason: { error: e?.message ?? 'moderation_error' },
        approved: false,
      })
      await notifyAdmins(userDoc.displayName ?? '', storageUrl)
      console.warn(
        `[moderation] Sightengine error for uid ${uid}: ${e?.message ?? e}`,
      )
    }
  },
)
