// recordSwipe, moved verbatim from the mobile codebase's index.ts (base snapshot,
// lines 438-473) into its own file; only its imports and the pinned runtime
// settings (legacyOptions.ts) are new.
import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { LEGACY_RUNTIME } from "./legacyOptions";
import { requirePlayAccess } from "../playAccess";
import { isSuspendedUid } from "../userData";
import { markActed } from "../explore";
import { requireUidOfPlayId } from "../playIds";
import { requireAvailableTarget } from "../likes";
import { takeRateLimit } from "../rateLimits";
import { isUidShape } from "../tapGuards";
import { dismissQueuedLike } from "../likerPreview";

export const recordSwipe = onCall(LEGACY_RUNTIME, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");

  const db = admin.firestore();
  const uid = request.auth.uid;
  const { targetUid: target, action, mode } = request.data as {
    targetUid: string;
    action: "like" | "pass" | "superlike" | "maybe";
    mode: "spark" | "play";
  };

  if (!target || !action || !mode) {
    throw new HttpsError("invalid-argument", "Missing required fields");
  }

  if (mode !== "spark" && mode !== "play") throw new HttpsError("invalid-argument", "Invalid mode");
  // F-090: a swipe is a write per call — capped well above any real deck pace.
  await takeRateLimit(uid, "swipe", { max: 300, windowMs: 10 * 60 * 1000 });
  // Stage 2: swiping in Play needs Play access.
  if (mode === "play") await requirePlayAccess(uid);
  // F-062: a Play card is named by its Play ID.
  const targetUid = mode === "play" ? await requireUidOfPlayId(target, uid) : target;
  if (!isUidShape(targetUid) || targetUid === uid) throw new HttpsError("invalid-argument", "Invalid target");

  // "maybe" (T&S Phase 1) is recorded for behaviour signals only — the card
  // stays in the deck.
  const validActions = ["like", "pass", "superlike", "maybe"];
  if (!validActions.includes(action)) {
    throw new HttpsError("invalid-argument", "Invalid action");
  }

  // Suspension check
  if (await isSuspendedUid(uid)) {
    throw new HttpsError("permission-denied", "Account suspended");
  }
  // F-090: no swipes recorded on someone who's gone, suspended or blocked either way.
  await requireAvailableTarget(uid, targetUid, mode);

  await db.collection("swipes").add({
    swiperId: uid,
    swipedId: targetUid,
    action,
    mode,
    timestamp: admin.firestore.Timestamp.now(),
  });
  // Explore (Stage 3): never shown again in this mode; the deck moves on.
  if (action !== "maybe") await markActed(uid, mode, targetUid);
  // §4.A3: passing on someone who liked you also moves their like to Viewed
  // (the app can't name a queue entry by uid any more).
  if (action === "pass") await dismissQueuedLike(uid, targetUid, mode);

  return { success: true };
});
