// recordSwipe, moved verbatim from the mobile codebase's index.ts (base snapshot,
// lines 438-473) into its own file; only its imports and the pinned runtime
// settings (legacyOptions.ts) are new.
import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { LEGACY_RUNTIME } from "./legacyOptions";

export const recordSwipe = onCall(LEGACY_RUNTIME, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");

  const db = admin.firestore();
  const uid = request.auth.uid;
  const { targetUid, action, mode } = request.data as {
    targetUid: string;
    action: "like" | "pass" | "superlike";
    mode: "spark" | "play";
  };

  if (!targetUid || !action || !mode) {
    throw new HttpsError("invalid-argument", "Missing required fields");
  }

  const validActions = ["like", "pass", "superlike"];
  if (!validActions.includes(action)) {
    throw new HttpsError("invalid-argument", "Invalid action");
  }

  // Suspension check
  const callerSnap = await db.collection("users").doc(uid).get();
  if (callerSnap.data()?.isSuspended === true) {
    throw new HttpsError("permission-denied", "Account suspended");
  }

  await db.collection("swipes").add({
    swiperId: uid,
    swipedId: targetUid,
    action,
    mode,
    timestamp: admin.firestore.Timestamp.now(),
  });

  return { success: true };
});
