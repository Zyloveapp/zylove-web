// functions/src/trustSafety.ts
//
// Trust/safety Callable Cloud Functions. These exist because the corresponding
// Firestore writes touch fields the client is forbidden from writing directly
// (isSuspended, reportCount, cross-user updates). Callables run with admin SDK
// and bypass firestore.rules.

import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { LEGACY_RUNTIME } from "./legacyOptions";
import { isPlayId, modeOfId, requireUidOfPlayId, uidNamedIn, uidOfPlayId } from "../playIds";
import { endPlayPair, loadMatch, type MatchCtx } from "../playMatch";
import { setPlayVisibility } from "../playAccess";
import { internalRef } from "../userData";
import { setBlocked } from "../explore";
import { clearLikesOnBlock } from "../likes";
import { blockModes, planBlock, type BlockMode } from "../blockCore";
import { PRESERVE_REPORTED_MS } from "../behavior";
import { liftBlock } from "../trust";
import { queueAdminAlert } from "../adminAlerts";

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
  await queueAdminAlert("deletionRequest", { subjectUid: uid });

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

// ─── blockUser ────────────────────────────────────────────────────────────────
// Server-side block with mirrored writes on both sides' blockedUsers subcollections.
// Optionally soft-deletes the match doc if matchId provided.

export const blockUser = onCall(LEGACY_RUNTIME, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Not signed in");

  const { targetUid: target, matchId } = request.data as {
    targetUid: string;
    matchId?: string;
  };

  if (typeof target !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(target)) {
    throw new HttpsError("invalid-argument", "targetUid required");
  }
  // F-062: from a Play chat, the other person is named by their Play ID.
  // F-064/F-065: with a match, only in that match's namespace (same answer as
  // a stranger otherwise); without one, the id's own namespace is the mode, so
  // a Play block is never listed (by uid) as a Spark one.
  let targetUid: string;
  if (matchId !== undefined) {
    const named = typeof matchId === "string" ? await uidNamedIn(matchId, target) : null;
    if (!named) throw new HttpsError("permission-denied", "Not your match");
    targetUid = named;
  } else {
    targetUid = isPlayId(target) ? await requireUidOfPlayId(target, uid) : target;
  }
  if (uid === targetUid) throw new HttpsError("invalid-argument", "Cannot block yourself");

  // Stage B: blocking stays open to suspended accounts (as reporting does) —
  // it only ever protects them.
  await blockPair(uid, targetUid, matchId, modeOfId(target));
  return { success: true };
});

// Mirror block (both directions) and, with a matchId, the match soft-ended.
// Shared with lockedPlay.ts (blocking a Play connection while Play is locked).
// Stage A: the match must be the two of theirs (anyone's id was accepted);
// both mirror docs record who blocked (blockedBy), which is what unblocking
// checks; and their likes go, so liking again can't re-create the match.
// C1 (review 2026-10-09): a block belongs to whoever placed it. The records
// are created, never overwritten: blocking someone who already blocked you
// changes nothing and still answers success — they used to take the block
// over, lift it and wipe the chat. A match already blocked keeps its blocker.
// H3: the records name the modes the block was placed in (blockCore.ts).
// H5: a live chat it ends stays readable to both for the report window.
export async function blockPair(uid: string, targetUid: string, matchId?: string, idMode?: "spark" | "play"): Promise<void> {
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();

  // A block without a match or an id's mode (none today) counts as Spark,
  // as unblocking and the lists read it.
  let mode: BlockMode = idMode ?? "spark";
  // F-062: a Play match (pm_…) too; its people are in the server-only record.
  const ctx = matchId ? await loadMatch(matchId) : null;
  if (matchId) {
    const sparkIdOk = ctx?.play || matchId === [uid, targetUid].sort().join("_");
    // F-078: the caller still has the chat (in a kept chat, only whoever it
    // was kept for — they may still block from it); the target is the other
    // person it was with.
    if (!ctx || !sparkIdOk || !ctx.has(uid) || !ctx.pair.includes(targetUid)) {
      throw new HttpsError("permission-denied", "Not your match");
    }
    mode = ctx.play || ctx.data.mode === "play" ? "play" : "spark";
  }
  const keys = ctx ? await chatKeysOf(ctx) : {};

  const mineRef = db.doc(`users/${uid}/blockedUsers/${targetUid}`);
  const theirsRef = db.doc(`users/${targetUid}/blockedUsers/${uid}`);
  const { plan, modes, matchEnded } = await db.runTransaction(async (tx) => {
    const [mine, theirs] = await tx.getAll(mineRef, theirsRef);
    const match = ctx ? (await tx.get(ctx.ref)).data() : undefined;
    const recs = [mine.data(), theirs.data()];
    const plan = planBlock(uid, recs, mode);
    const modes: BlockMode[] = [...new Set([...recs.flatMap((r) => (r ? (blockModes(r) ?? []) : [])), mode])];
    if (plan === "create") {
      const rec = { blockedAt: now, blockedBy: uid, mode, modes: [mode] };
      tx.create(mineRef, { uid: targetUid, ...rec });
      tx.create(theirsRef, { uid, ...rec });
    } else if (plan === "extend") {
      // Their own block, now in this mode too (each record as it stands).
      for (const [ref, rec, who] of [[mineRef, recs[0], targetUid], [theirsRef, recs[1], uid]] as const) {
        tx.set(ref, { uid: who, blockedBy: uid, blockedAt: rec?.blockedAt ?? now, modes }, { merge: true });
      }
    }
    // The match ends with this block unless it already has (C1: never
    // re-attributed). If the other person had blocked first, it ends as
    // their block — the block between them is theirs.
    if (!ctx || !match || match.isBlocked === true) return { plan, modes, matchEnded: false };
    const by: unknown = plan === "noop" ? recs.find((r) => r)?.blockedBy : uid;
    const blocker = typeof by === "string" && ctx.pair.includes(by) ? by : uid;
    const live = match.unmatchedAt === undefined || match.unmatchedAt === null;
    tx.update(ctx.ref, {
      isBlocked: true,
      blockedBy: ctx.idOf(blocker),
      blockedAt: now,
      // H5: read-only for both (the person blocked keeps what was said to
      // them, to report it), with both chat keys — the person blocked can't
      // read the other's profile, where the key is. A chat already kept for
      // one person (unmatched) stays theirs.
      ...(live && ctx.users.length === 2
        ? {
            preservedFor: ctx.users.map((u) => ctx.idOf(u)).sort(),
            preservedUntil: admin.firestore.Timestamp.fromMillis(now.toMillis() + PRESERVE_REPORTED_MS),
            preservedForReport: false,
          }
        : {}),
      ...(Object.keys(keys).length ? { chatKeys: keys } : {}),
    });
    return { plan, modes, matchEnded: true };
  });

  if (ctx && matchEnded) await endPlayPair(ctx);
  if (plan === "noop" || plan === "same") return;
  await clearLikesOnBlock(uid, targetUid, mode);
  // Explore (Stage 3): neither is shown to the other — the blocker only in
  // this mode (H3).
  await setBlocked(uid, targetUid, modes);
}

// H5: both people's chat public keys as this match names them (the Spark key
// on the profile, the Play key on the Play profile), for the match doc.
async function chatKeysOf(ctx: MatchCtx): Promise<Record<string, string>> {
  const db = admin.firestore();
  const out: Record<string, string> = {};
  for (const u of ctx.pair) {
    const id = ctx.idOf(u);
    if (!id) continue;
    const key: unknown = ctx.play
      ? (await db.doc(`playProfiles/${id}`).get()).get("publicPlayKey")
      : (await db.doc(`users/${u}`).get()).get("publicKey");
    if (typeof key === "string" && key.length > 0 && key.length <= 100) out[id] = key;
  }
  return out;
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
  // blocked could lift it here. F-062: a Play ID names the person in Play.
  // F-065: only a block in the id's own mode (a uid lifts a Spark block, a
  // Play ID a Play one) — anything else is "not found", like a stranger.
  const lifted = isPlayId(targetUid) ? await uidOfPlayId(targetUid) : targetUid;
  if (!lifted) throw new HttpsError("not-found", "You haven't blocked this person");
  await liftBlock(uid, lifted, modeOfId(targetUid));
  return { success: true };
});
