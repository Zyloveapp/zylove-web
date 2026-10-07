// functions/src/trustSafety.ts
//
// Trust/safety Callable Cloud Functions. These exist because the corresponding
// Firestore writes touch fields the client is forbidden from writing directly
// (isSuspended, reportCount, cross-user updates). Callables run with admin SDK
// and bypass firestore.rules.

import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { LEGACY_RUNTIME } from "./legacyOptions";
import { setPlayVisibility } from "../playAccess";
import { internalRef, isSuspendedUid } from "../userData";
import { setBlocked } from "../explore";
import { clearLikes } from "../likes";
import { liftBlock } from "../trust";

const REPORT_TIERS = {
  spam: 1, fake_profile: 1, low_effort: 1, misleading_photos: 1, inappropriate_username: 1,
  harassment: 2, unsolicited_explicit: 2, threats: 2, hate_speech: 2, stalking: 2, solicitation: 2,
  minor_in_photos: 3, non_consensual_content: 3, violence: 3, trafficking: 3, criminal_activity: 3,
} as const;

type ReportCategory = keyof typeof REPORT_TIERS;

// ─── reportUser ───────────────────────────────────────────────────────────────
// Writes the report record + increments the target's reportCount +
// suspends on Tier 3. Auto-block happens client-side after this returns
// (blockedUsers writes are rule-allowed).

export const reportUser = onCall(LEGACY_RUNTIME, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");
  const db = admin.firestore();
  const reporterUid = request.auth.uid;

  if (await isSuspendedUid(reporterUid)) {
    throw new HttpsError("permission-denied", "Account suspended");
  }

  const { targetUid, category, details, matchId, evidenceMessageIds } = request.data ?? {};

  if (!targetUid || typeof targetUid !== "string") {
    throw new HttpsError("invalid-argument", "targetUid required");
  }
  if (reporterUid === targetUid) {
    throw new HttpsError("invalid-argument", "Cannot report yourself");
  }
  const tier = REPORT_TIERS[category as ReportCategory];
  if (!tier) throw new HttpsError("invalid-argument", "Unknown report category");

  const reportId = `${reporterUid}_${targetUid}_${Date.now()}`;
  const record = {
    reportId,
    reporterUid,
    reportedUid: targetUid,
    category,
    tier,
    details: typeof details === "string" ? details.slice(0, 500) : undefined,
    matchId: typeof matchId === "string" ? matchId : undefined,
    evidenceMessageIds: Array.isArray(evidenceMessageIds) ? evidenceMessageIds : undefined,
    reportedAt: Date.now(),
    status: "pending",
  };

  const batch = db.batch();
  batch.set(db.collection("reports").doc(reportId), record);
  // Report counts and (tier 3) the suspension: server-only (userInternal).
  batch.set(internalRef(targetUid), {
    reportCount: admin.firestore.FieldValue.increment(1),
    [`reportTier${tier}Count`]: admin.firestore.FieldValue.increment(1),
    ...(tier === 3 && {
      isSuspended: true,
      suspendedAt: admin.firestore.FieldValue.serverTimestamp(),
      suspendReason: `Tier 3 report: ${category}`,
      suspendedPendingReview: true,
    }),
  }, { merge: true });
  await batch.commit();

  return { success: true, tier };
});

// ─── requestAccountDeletion ───────────────────────────────────────────────────
// 30-day grace-period "pause" flow. Sets isSuspended on self + writes
// deletionRequests/{uid}. Reversible via cancelAccountDeletion.

const GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export const requestAccountDeletion = onCall(LEGACY_RUNTIME, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");
  const db = admin.firestore();
  const uid = request.auth.uid;
  const reason = typeof request.data?.reason === "string" ? request.data.reason.slice(0, 500) : null;
  const now = Date.now();
  const scheduledFor = now + GRACE_PERIOD_MS;

  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "User not found");

  // Suspended and the pending deletion: server-only (userInternal, Stage 3).
  // Stage A: suspendedForDeletion says this request did the suspending, so
  // cancelling lifts only that — never a moderation suspension.
  const internal = (await internalRef(uid).get()).data() ?? {};
  const alreadySuspended = internal.isSuspended === true && internal.suspendedForDeletion !== true;
  await internalRef(uid).set({
    isSuspended: true,
    suspendedForDeletion: !alreadySuspended,
    deletionRequestedAt: now,
    deletionScheduledFor: scheduledFor,
    deletionReason: reason,
  }, { merge: true });
  await userRef.update({
    sparkVisibility: "hidden",
    playVisibility: admin.firestore.FieldValue.delete(), // lives on the Play profile (Stage 2)
  });
  await setPlayVisibility(uid, "hidden");

  await db.collection("deletionRequests").doc(uid).set({
    uid,
    requestedAt: admin.firestore.FieldValue.serverTimestamp(),
    // A Timestamp, so processGraceExpiredDeletions' scheduledFor <= now query
    // matches it (Firestore never compares a number with a Timestamp). B-002.
    scheduledFor: admin.firestore.Timestamp.fromMillis(scheduledFor),
    reason,
    status: "pending",
  });

  return { success: true, scheduledFor };
});

// ─── cancelAccountDeletion ────────────────────────────────────────────────────
// Reverses requestAccountDeletion. Clears isSuspended + deletion fields +
// deletes the deletionRequests doc.

export const cancelAccountDeletion = onCall(LEGACY_RUNTIME, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");
  const db = admin.firestore();
  const uid = request.auth.uid;

  const userRef = db.collection("users").doc(uid);
  const internal = (await internalRef(uid).get()).data() ?? {};
  if (!internal.deletionRequestedAt) throw new HttpsError("failed-precondition", "No deletion to cancel");
  // Stage A: lift only the suspension the deletion request set.
  const liftSuspension = internal.suspendedForDeletion === true;
  await internalRef(uid).set({
    ...(liftSuspension ? { isSuspended: false } : {}),
    suspendedForDeletion: admin.firestore.FieldValue.delete(),
    deletionRequestedAt: admin.firestore.FieldValue.delete(),
    deletionScheduledFor: admin.firestore.FieldValue.delete(),
    deletionReason: admin.firestore.FieldValue.delete(),
  }, { merge: true });
  if (!liftSuspension) {
    await db.collection("deletionRequests").doc(uid).delete().catch(() => {});
    return { success: true };
  }
  await userRef.update({
    sparkVisibility: "active",
    playVisibility: admin.firestore.FieldValue.delete(), // lives on the Play profile (Stage 2)
  });
  await setPlayVisibility(uid, "active");

  await db.collection("deletionRequests").doc(uid).delete().catch(() => {
    // Tolerate missing doc — user may have bypassed the deletionRequests write
  });

  return { success: true };
});

// ─── submitUnmatch ────────────────────────────────────────────────────────────
// Server-side consolidation of the 4 client-direct writes previously in
// UnmatchSheet.tsx (unmatchReasons + scoreEvents + reviewQueue + match delete).
// Single atomic batch. Caller suspension check + match-participant check.

// Server-side reason table — client cannot spoof scoreImpact or flagForReview
const UNMATCH_REASONS: Record<string, { scoreImpact: number; flagForReview: boolean }> = {
  lost_interest:          { scoreImpact:  0,  flagForReview: false },
  no_longer_available:    { scoreImpact:  0,  flagForReview: false },
  not_what_i_expected:    { scoreImpact: -2,  flagForReview: false },
  disrespectful:          { scoreImpact: -5,  flagForReview: true  },
  inappropriate_messages: { scoreImpact: -8,  flagForReview: true  },
  fake_profile:           { scoreImpact: -10, flagForReview: true  },
  harassment:             { scoreImpact: -10, flagForReview: true  },
  other:                  { scoreImpact:  0,  flagForReview: false },
};

export const submitUnmatch = onCall(LEGACY_RUNTIME, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Not signed in");

  const { matchId, partnerUid, reason, mode } = request.data as {
    matchId: string;
    partnerUid: string;
    reason: string;
    mode: "spark" | "play";
  };

  if (!matchId || !partnerUid || !reason || !mode) {
    throw new HttpsError("invalid-argument", "Missing required fields");
  }

  const db = admin.firestore();

  // Suspension check
  if (await isSuspendedUid(uid)) {
    throw new HttpsError("permission-denied", "Account suspended");
  }

  // Validate caller is a match participant
  const matchSnap = await db.collection("matches").doc(matchId).get();
  if (!matchSnap.exists) throw new HttpsError("not-found", "Match not found");
  const matchUsers: string[] = matchSnap.data()?.users ?? [];
  if (!matchUsers.includes(uid)) {
    throw new HttpsError("permission-denied", "Not a match participant");
  }

  // Lookup reason — reject unknown reasons
  const reasonData = UNMATCH_REASONS[reason];
  if (!reasonData) throw new HttpsError("invalid-argument", "Unknown unmatch reason");

  const { scoreImpact, flagForReview } = reasonData;
  const batch = db.batch();

  // 1. Record unmatch reason
  const reasonRef = db.collection("unmatchReasons").doc();
  batch.set(reasonRef, {
    matchId,
    reporterUid: uid,
    reportedUid: partnerUid,
    reason,
    scoreImpact,
    flagForReview,
    mode,
    createdAt: admin.firestore.Timestamp.now(),
  });

  // 2. Score event (only if impact !== 0)
  if (scoreImpact !== 0) {
    const scoreRef = db.collection("scoreEvents").doc();
    batch.set(scoreRef, {
      uid: partnerUid,
      delta: scoreImpact,
      reason: `unmatch_${reason}`,
      matchId,
      createdAt: admin.firestore.Timestamp.now(),
    });
  }

  // 3. Flag for review if needed
  if (flagForReview) {
    const reviewRef = db.collection("reviewQueue").doc();
    batch.set(reviewRef, {
      reportedUid: partnerUid,
      reporterUid: uid,
      reason,
      matchId,
      priority: "normal",
      createdAt: admin.firestore.Timestamp.now(),
    });
  }

  // 4. Delete match doc
  batch.delete(db.collection("matches").doc(matchId));

  await batch.commit();

  return { success: true };
});

// ─── blockUser ────────────────────────────────────────────────────────────────
// Server-side block with mirrored writes on both sides' blockedUsers subcollections.
// Optionally soft-deletes the match doc if matchId provided.

export const blockUser = onCall(LEGACY_RUNTIME, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Not signed in");

  const { targetUid, matchId } = request.data as {
    targetUid: string;
    matchId?: string;
  };

  if (typeof targetUid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(targetUid)) {
    throw new HttpsError("invalid-argument", "targetUid required");
  }
  if (uid === targetUid) throw new HttpsError("invalid-argument", "Cannot block yourself");

  // Suspension check
  if (await isSuspendedUid(uid)) {
    throw new HttpsError("permission-denied", "Account suspended");
  }

  await blockPair(uid, targetUid, matchId);
  return { success: true };
});

// Mirror block (both directions) and, with a matchId, the match soft-ended.
// Shared with lockedPlay.ts (blocking a Play connection while Play is locked).
// Stage A: the match must be the two of theirs (anyone's id was accepted);
// both mirror docs record who blocked (blockedBy), which is what unblocking
// checks; and their likes go, so liking again can't re-create the match.
export async function blockPair(uid: string, targetUid: string, matchId?: string): Promise<void> {
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();
  const batch = db.batch();

  let mode: "spark" | "play" | null = null;
  if (matchId) {
    const match = (await db.collection("matches").doc(matchId).get()).data();
    const users: unknown[] = Array.isArray(match?.users) ? match!.users : [];
    if (!match || matchId !== [uid, targetUid].sort().join("_") || !users.includes(uid) || !users.includes(targetUid)) {
      throw new HttpsError("permission-denied", "Not your match");
    }
    mode = match.mode === "play" ? "play" : "spark";
  }

  // Mirror block — both directions
  batch.set(
    db.collection(`users/${uid}/blockedUsers`).doc(targetUid),
    { uid: targetUid, blockedAt: now, blockedBy: uid, ...(mode ? { mode } : {}) },
  );
  batch.set(
    db.collection(`users/${targetUid}/blockedUsers`).doc(uid),
    { uid, blockedAt: now, blockedBy: uid, ...(mode ? { mode } : {}) },
  );

  // Soft-delete match if provided
  if (matchId) {
    batch.update(db.collection("matches").doc(matchId), {
      isBlocked: true,
      blockedBy: uid,
      blockedAt: now,
    });
  }

  await batch.commit();
  await clearLikes(uid, targetUid, null);
  // Explore (Stage 3): neither is shown to the other.
  await setBlocked(uid, targetUid, true);
}

// ─── unblockUser ──────────────────────────────────────────────────────────────
// Mirror delete of both sides' blockedUsers subcollection entries.
// Suspension check intentionally omitted — suspended users can still unblock
// (graceful exit should always be available).

export const unblockUser = onCall(LEGACY_RUNTIME, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Not signed in");

  const { targetUid } = request.data as { targetUid: string };
  if (typeof targetUid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(targetUid)) {
    throw new HttpsError("invalid-argument", "targetUid required");
  }
  // Stage A: only a block the caller placed (as unblockMember) — the person
  // blocked could lift it here.
  await liftBlock(uid, targetUid);
  return { success: true };
});
