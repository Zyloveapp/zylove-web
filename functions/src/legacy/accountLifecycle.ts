import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { LEGACY_RUNTIME } from "./legacyOptions";
import { UserDoc } from "./types";
import { normalizeE164 } from "./utils/phone";
import { ROOT_SCRUB, clearPrivateData, deletionView, identityRef, internalRef, loadPrivateProfile, profileRef } from "../userData";



// ─── deleteAccount ────────────────────────────────────────────────────────────
export const deleteAccount = onCall(LEGACY_RUNTIME, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");
const db = admin.firestore();
const auth = admin.auth();
  const uid = request.auth.uid;
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();

  if (!userSnap.exists) throw new HttpsError("not-found", "User not found");

  const user = userSnap.data() as UserDoc;

  // Phone number — prefer Firebase Auth's E.164 value, fall back to
  // normalizing the user doc value. Every delete must resolve to a
  // normalized E.164 string or we refuse — the recovery doc ID depends on it.
  const authUser = await auth.getUser(uid);
  const phoneNumber = normalizeE164(authUser.phoneNumber)
    ?? normalizeE164((user as any).phoneNumber);

  if (!phoneNumber) {
    throw new HttpsError(
      "failed-precondition",
      "Cannot delete account without a valid phone number.",
    );
  }

  // Grab all pair IDs so we can re-link on restore
  const [asA, asB] = await Promise.all([
    db.collection("pairs").where("userA", "==", uid).get(),
    db.collection("pairs").where("userB", "==", uid).get(),
  ]);
  const previousPairIds = [...asA.docs, ...asB.docs].map((d) => d.id);
  // Birthday, plan and report count live off the public doc now.
  const priv = await deletionView(uid, user as any);

  // Capture recovery data — every field needed to restore identity lock +
  // policy state. Behavior score intentionally NOT captured; restored
  // accounts reset to 50. reportCount preserved for admin audit but reset
  // to 0 on restore so reputation doesn't leak across the delete/restore
  // boundary (server-side policy, not the client).
  const recoveryData: Record<string, any> = {
    phoneNumber,
    previousUid: uid,
    deletedAt: admin.firestore.Timestamp.now(),

    // Identity (locked on restore — immutability contract)
    birthday:           priv.birthday,
    genderIdentity:     (user as any).genderIdentity ?? null,
    matchableAs:        (user as any).matchableAs ?? [],
    identityLockedAt:   (user as any).identityLockedAt ?? null,
    pronouns:           (user as any).pronouns ?? null,
    genderSelfDescribe: (user as any).genderSelfDescribe ?? null,

    // Profile content (restored on restore)
    displayName: user.displayName ?? "",
    photoURLs:   user.photoURLs ?? [],
    bio:         user.bio ?? "",
    mode:        (await loadPrivateProfile(uid, user as any)).mode ?? "spark",

    // Policy state
    isFounder: (user as any).isFounder ?? false,
    subscriptionTier: priv.subscriptionTier,
    reportCount:      priv.reportCount,

    // Ban flag (set manually via admin SDK for bad actors)
    banned: false,

    // Pair cleanup tracking
    previousPairIds,
  };

  await db.collection("deletedAccounts").doc(phoneNumber).set(recoveryData);

  // Soft-delete the user doc (anonymize PII). isSuspended: true ensures
  // firestore rules hide this user from all discovery reads.
  await userRef.update({
    deleted: true,
    isDeleted: true,
    deletedAt: admin.firestore.Timestamp.now(),
    isSuspended: true,
    displayName: "Deleted User",
    bio: "",
    photoURLs: [],
    visible: false,
    isVisible: false,
    locationLabel: "",
    ...ROOT_SCRUB,
  });
  await clearPrivateData(uid);

  // Delete Firebase Auth user last
  await auth.deleteUser(uid);

  return { success: true };
});

// ─── checkRestoreEligibility ──────────────────────────────────────────────────
// Called immediately after phone auth — before onboarding. Returns a
// discriminated status that the client uses to route: clear → normal
// onboarding, hard_block → show restore UI (< 90 days), soft_block →
// show pre-filled identity onboarding (> 90 days), permanently_banned →
// support email only.
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export const checkRestoreEligibility = onCall(LEGACY_RUNTIME, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");
  const db = admin.firestore();
  const auth = admin.auth();
  const uid = request.auth.uid;

  // Pre-flight gate — if the live user doc is suspended, short-circuit
  // before checking deletion-recovery state. Front-end routes to /suspended.
  const userSnap = await db.doc(`users/${uid}`).get();
  if (userSnap.data()?.isSuspended === true) {
    return { status: "suspended" as const };
  }

  const authUser = await auth.getUser(uid);
  const phoneNumber = normalizeE164(authUser.phoneNumber);

  if (!phoneNumber) {
    return { status: "clear" as const };
  }

  const recoveryRef = db.collection("deletedAccounts").doc(phoneNumber);
  const recoverySnap = await recoveryRef.get();

  if (!recoverySnap.exists) {
    return { status: "clear" as const };
  }

  const recovery = recoverySnap.data()!;

  // Permanent ban — no restore path, support email only
  if (recovery.banned === true) {
    return { status: "permanently_banned" as const };
  }

  // 90-day retention window
  const deletedAt = recovery.deletedAt as admin.firestore.Timestamp;
  const msSinceDeletion = Date.now() - deletedAt.toMillis();
  const withinWindow = msSinceDeletion < NINETY_DAYS_MS;

  // Return minimal recovery data — don't leak reportCount or banned
  // state to client. Identity fields included so soft-block onboarding
  // can display what's about to be pre-locked.
  const recoveryData = {
    phoneNumber:        recovery.phoneNumber,
    displayName:        recovery.displayName,
    photoURLs:          recovery.photoURLs,
    isFounder:   recovery.isFounder,
    subscriptionTier:   recovery.subscriptionTier,
    deletedAt:          recovery.deletedAt,
    birthday:           recovery.birthday,
    genderIdentity:     recovery.genderIdentity,
    matchableAs:        recovery.matchableAs,
    pronouns:           recovery.pronouns,
    genderSelfDescribe: recovery.genderSelfDescribe,
  };

  return {
    status: withinWindow ? ("hard_block" as const) : ("soft_block" as const),
    recoveryData,
  };
});

// ─── restoreAccount ───────────────────────────────────────────────────────────
// Recovery-doc is the source of truth — no spread of the old soft-deleted
// user doc. Every field on the new user doc is an intentional restore or
// an explicit reset. Callable path; IAM allUsers invoker confirmed in
// Commit C project-policy override.
export const restoreAccount = onCall(LEGACY_RUNTIME, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");
  const db = admin.firestore();
  const auth = admin.auth();
  const newUid = request.auth.uid;
  const authUser = await auth.getUser(newUid);
  const phoneNumber = normalizeE164(authUser.phoneNumber);

  if (!phoneNumber) {
    throw new HttpsError("failed-precondition", "No phone number associated with this account.");
  }

  const recoveryRef = db.collection("deletedAccounts").doc(phoneNumber);
  const recoverySnap = await recoveryRef.get();

  if (!recoverySnap.exists) {
    throw new HttpsError("not-found", "No deleted account found for this phone number.");
  }

  const recovery = recoverySnap.data()!;

  // Block restore if permanently banned
  if (recovery.banned === true) {
    throw new HttpsError("permission-denied", "This account cannot be restored. Contact support.");
  }

  // Enforce 90-day window server-side (defense-in-depth; client should
  // never call restoreAccount outside hard_block status)
  const deletedAt = recovery.deletedAt as admin.firestore.Timestamp;
  const msSinceDeletion = Date.now() - deletedAt.toMillis();

  if (msSinceDeletion >= NINETY_DAYS_MS) {
    throw new HttpsError(
      "failed-precondition",
      "Restore window has expired. Complete onboarding to create a new account.",
    );
  }

  // Build restored user doc from recovery — explicit, no spread. Every
  // field is a conscious decision.
  const now = admin.firestore.Timestamp.now();
  const previousUid = recovery.previousUid;

  // The phone number stays in Auth; birthday goes to private/identity and
  // the plan to userInternal — none of it on the public doc.
  const restoredUser: Record<string, any> = {
    uid: newUid,

    // Identity — restored and locked (immutability contract)
    genderIdentity:     recovery.genderIdentity,
    matchableAs:        recovery.matchableAs ?? [],
    identityLockedAt:   recovery.identityLockedAt ?? now,
    pronouns:           recovery.pronouns,
    genderSelfDescribe: recovery.genderSelfDescribe,

    // Profile content — restored
    displayName: recovery.displayName ?? "",
    photoURLs:   recovery.photoURLs ?? [],
    bio:         recovery.bio ?? "",

    // Policy state
    isFounder: recovery.isFounder ?? false,

    // Behavior score — explicit reset to neutral
    behaviorScore: 50,

    // Lineage
    previousUid,
    restoredAt: now,

    // Visibility — explicit, NOT spread from old doc. The old soft-delete
    // set isSuspended:true, isDeleted:true, etc. Reset all of it here.
    deleted:     false,
    isDeleted:   false,
    deletedAt:   null,
    isSuspended: false,
    visible:     true,
    isVisible:   true,

    // Geo — user will re-grant location on next app open
    locationLabel: "",
  };

  const batch = db.batch();

  // Write new user doc
  batch.set(db.collection("users").doc(newUid), restoredUser);
  batch.set(identityRef(newUid), { birthday: recovery.birthday ?? null });
  // The mode is owner-only (Stage 2), never on the public doc.
  batch.set(profileRef(newUid), { mode: recovery.mode === "play" ? "play" : "spark" }, { merge: true });
  batch.set(internalRef(newUid), {
    subscriptionTier: recovery.isFounder ? "elite" : (recovery.subscriptionTier ?? "free"),
    reportCount: 0,
  }, { merge: true });

  // Re-link pair docs from previousUid to newUid. Handles userA/userB AND
  // the users[] array introduced in Commit C (match rule relies on it).
  const pairIds: string[] = recovery.previousPairIds ?? [];
  for (const pairId of pairIds) {
    const pairRef = db.collection("pairs").doc(pairId);
    const pairSnap = await pairRef.get();
    if (!pairSnap.exists) continue;
    const pair = pairSnap.data()!;
    const updates: Record<string, any> = {};
    if (pair.userA === previousUid) updates.userA = newUid;
    if (pair.userB === previousUid) updates.userB = newUid;
    if (Array.isArray(pair.users) && pair.users.includes(previousUid)) {
      updates.users = pair.users.map((u: string) => (u === previousUid ? newUid : u));
    }
    if (Object.keys(updates).length > 0) {
      batch.update(pairRef, updates);
    }
  }

  // NOTE: previousUid's user doc may have been purged by onNightlyPurge
  // if the account was deleted >12 months ago. This batch.delete is a no-op
  // in that case, which is fine. Any future logic that READS
  // users/{previousUid} must handle missing doc.
  batch.delete(db.collection("users").doc(previousUid));
  batch.delete(recoveryRef);

  await batch.commit();

  return {
    success: true,
    isFounder: recovery.isFounder ?? false,
  };
});

// ─── softBlockOnboarding ──────────────────────────────────────────────────────
// Called when a phone number has a deletedAccounts doc OLDER than 90 days.
// Creates a new user doc with identity fields pre-locked from the recovery
// doc, then deletes the recovery doc (user has "aged out" — fresh start on
// everything except identity). Behavior score, subscription, founding
// status all reset.
//
// The client is responsible for routing the user through onboarding with
// identityLockedAt already set — the onboarding prefill guard will handle
// skipping the identity slide (Commit E2 wiring).
export const softBlockOnboarding = onCall(LEGACY_RUNTIME, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");
  const db = admin.firestore();
  const auth = admin.auth();
  const newUid = request.auth.uid;
  const authUser = await auth.getUser(newUid);
  const phoneNumber = normalizeE164(authUser.phoneNumber);

  if (!phoneNumber) {
    throw new HttpsError("failed-precondition", "No phone number on account.");
  }

  const recoveryRef = db.collection("deletedAccounts").doc(phoneNumber);
  const recoverySnap = await recoveryRef.get();

  if (!recoverySnap.exists) {
    // No prior account — caller should use normal onboarding
    return { prefilled: false as const };
  }

  const recovery = recoverySnap.data()!;

  if (recovery.banned === true) {
    throw new HttpsError("permission-denied", "This account cannot be restored. Contact support.");
  }

  const deletedAt = recovery.deletedAt as admin.firestore.Timestamp;
  const msSinceDeletion = Date.now() - deletedAt.toMillis();

  if (msSinceDeletion < NINETY_DAYS_MS) {
    throw new HttpsError(
      "failed-precondition",
      "Still within restore window. Use restoreAccount.",
    );
  }

  // Fresh-start user doc with locked identity only
  const now = admin.firestore.Timestamp.now();

  const prefillUser: Record<string, any> = {
    uid: newUid,

    // Identity — locked from recovery (immutability contract)
    genderIdentity:     recovery.genderIdentity,
    matchableAs:        recovery.matchableAs ?? [],
    identityLockedAt:   now,
    pronouns:           recovery.pronouns,
    genderSelfDescribe: recovery.genderSelfDescribe,

    // Everything else — fresh defaults
    displayName:      "",
    photoURLs:        [],
    bio:              "",
    isFounder: false,
    behaviorScore:    50,

    // Lineage — for audit trail
    previousUid:            recovery.previousUid,
    softBlockedFrom:        recovery.previousUid,
    onboardingCompletedAt:  null,

    // Visibility — user becomes visible after onboarding completes
    deleted:     false,
    isDeleted:   false,
    isSuspended: false,
    visible:     false,
    isVisible:   false,
  };

  const batch = db.batch();
  batch.set(db.collection("users").doc(newUid), prefillUser);
  batch.set(identityRef(newUid), { birthday: recovery.birthday ?? null });
  batch.set(internalRef(newUid), { subscriptionTier: "free", reportCount: 0 }, { merge: true });
  batch.delete(recoveryRef);
  await batch.commit();

  return {
    prefilled: true as const,
    identity: {
      birthday:           recovery.birthday,
      genderIdentity:     recovery.genderIdentity,
      matchableAs:        recovery.matchableAs,
      pronouns:           recovery.pronouns,
      genderSelfDescribe: recovery.genderSelfDescribe,
    },
  };
});
