// onProfileWrite, moved from the mobile codebase's index.ts (deployed
// snapshot, lines 597-658). Engine v2 (2026-10) split the per-pair step out
// as rescorePair (shared with scripts/rescore-pairs.mjs) and added the
// private/profile and private/matching triggers.
import * as admin from "firebase-admin";
import { onDocumentUpdated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { calculateSparkScore, calculatePlayScore, deepFitRecord, SCORE_ENGINE_VERSION, sparkPairFields } from "./scoring";
import { UserDoc, PairDoc } from "./types";
import { LEGACY_RUNTIME } from "./legacyOptions";
import { bothHavePlay, playFields, setPlayScores } from "../pairPlay";
import { otherUidOf } from "../playPairQueries";
import { isSuspendedUid, withPrivateProfile } from "../userData";
import { writeSparkDetails } from "../pairSpark";

// The user's scoring view: root + private profile/matching, and with their
// Play profile on top for Play scoring.
export async function scoringDocs(userId: string, root: UserDoc): Promise<{ spark: UserDoc; full: UserDoc }> {
  const db = admin.firestore();
  // Scoring compares intents, which live in the owner-only private/profile (Stage 2).
  const spark = await withPrivateProfile(userId, root) as UserDoc;
  const playSnap = await db.collection("users").doc(userId)
    .collection("playProfile").doc("data").get().catch(() => null);
  const playData = playSnap?.exists ? playSnap.data() ?? {} : {};
  return { spark, full: { ...spark, ...playOverlay(playData) } as UserDoc };
}

// F-099: what the Play profile may add for Play scoring — its Play fields,
// never the owner-only matching or identity fields. The Play profile takes
// any keys from its owner, so a copy there would dodge the 30-day limit on
// religion, politics, drinking, attraction, dealbreakers and intent, and the
// identity lock on gender and age. (The app never writes them there; older
// curated profiles carry copies equal to their own values.)
export const PLAY_OVERLAY_EXCLUDED = [
  'religion', 'politicalView', 'drinkingHabit', 'attractedTo', 'dealbreakers', 'intent',
  'genderIdentity', 'genderSelfDescribe', 'matchableAs', 'age', 'birthday',
] as const;
export function playOverlay(playData: Record<string, unknown>): Record<string, unknown> {
  const out = { ...playData };
  for (const k of PLAY_OVERLAY_EXCLUDED) delete out[k];
  return out;
}

// Re-scores one pair from `userId`'s side and adds the writes to `batch`
// (none when batch is null — a dry run). Returns the new Spark result, or
// null when the other person is gone. Shared by rescorePairs and
// scripts/rescore-pairs.mjs, so the backfill writes exactly what a live
// re-score does.
export async function rescorePair(
  batch: admin.firestore.WriteBatch | null,
  pairSnap: admin.firestore.QueryDocumentSnapshot | admin.firestore.DocumentSnapshot,
  userId: string,
  mine: { spark: UserDoc; full: UserDoc },
): Promise<ReturnType<typeof calculateSparkScore> | null> {
  const db = admin.firestore();
  const pair     = pairSnap.data() as PairDoc;
  const otherUid = pair.userA === userId ? pair.userB : pair.userA;

  const otherSnap = await db.collection("users").doc(otherUid).get();
  if (!otherSnap.exists || otherSnap.data()?.isDeleted === true) return null;
  const other = await scoringDocs(otherUid, (otherSnap.data() ?? {}) as UserDoc);

  const spark = calculateSparkScore(mine.spark, other.spark);
  if (!batch) return spark;

  // Stage C: the details go to the plan-gated sub-docs (pairSpark.ts).
  writeSparkDetails(batch, pairSnap.id, { breakdown: spark.breakdown, dealbreakers: spark.triggeredDealbreakers, tier1: deepFitRecord(spark.tier1, userId, otherUid) }, false);
  batch.update(pairSnap.ref, {
    ...sparkPairFields(spark),
    sparkBreakdown: admin.firestore.FieldValue.delete(),
    triggeredDealbreakers: admin.firestore.FieldValue.delete(),
    tier1Spark: admin.firestore.FieldValue.delete(),
    // Older pair docs carried the Play scores; they live in the subdoc now.
    playScore: admin.firestore.FieldValue.delete(),
    playBreakdown: admin.firestore.FieldValue.delete(),
    tier1Play: admin.firestore.FieldValue.delete(),
    scoreCalculatedAt: admin.firestore.Timestamp.now(),
    scoreVersion:      admin.firestore.FieldValue.increment(1),
  });
  return spark;
}

// F-065: Play scores live in playPairData (keyed by Play IDs) — rescored from
// those docs, only while both people have Play access; otherwise removed.
async function rescorePlayPairs(userId: string, mine: { spark: UserDoc; full: UserDoc }): Promise<void> {
  const db = admin.firestore();
  const snap = await db.collection("playPairData").where("users", "array-contains", userId).get();
  for (const d of snap.docs) {
    const otherUid = otherUidOf(d.data(), userId);
    if (!otherUid) continue;
    const otherSnap = await db.collection("users").doc(otherUid).get();
    if (!otherSnap.exists || otherSnap.data()?.isDeleted === true) continue;
    if (!(await bothHavePlay(userId, otherUid))) {
      await setPlayScores(userId, otherUid, null);
      continue;
    }
    const other = await scoringDocs(otherUid, (otherSnap.data() ?? {}) as UserDoc);
    const { score, breakdown, tier1 } = calculatePlayScore(mine.full, other.full);
    if ((await db.doc(`users/${userId}`).get()).data()?.isDeleted === true) return;
    await setPlayScores(userId, otherUid, { ...playFields(score, breakdown, tier1), engineVersion: SCORE_ENGINE_VERSION });
  }
}

// Rescores every pair of userId. Spark scores on the pair doc; Play scores
// in playPairData (rescorePlayPairs).
async function rescorePairs(userId: string, afterRoot: UserDoc): Promise<void> {
  const db = admin.firestore();
  // A deleted or suspended account isn't rescored (deletion removes its Play
  // scores; a rescore racing it must not write them back).
  if ((afterRoot as any).isDeleted === true || (await isSuspendedUid(userId, afterRoot as any))) return;
  const mine = await scoringDocs(userId, afterRoot);

  const [asA, asB] = await Promise.all([
    db.collection("pairs").where("userA", "==", userId).get(),
    db.collection("pairs").where("userB", "==", userId).get(),
  ]);

  await rescorePlayPairs(userId, mine);
  const allPairs = [...asA.docs, ...asB.docs];
  if (!allPairs.length) return;

  const BATCH_SIZE = 200;
  for (let i = 0; i < allPairs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = allPairs.slice(i, i + BATCH_SIZE);
    await Promise.all(chunk.map((pairSnap) => rescorePair(batch, pairSnap, userId, mine)));
    // Re-check right before writing: an account deleted while this ran
    // (deletion removes its Play scores) must not get them written back.
    if ((await db.doc(`users/${userId}`).get()).data()?.isDeleted === true) return;
    await batch.commit();
  }
}

export const onProfileWrite = onDocumentUpdated({ document: "users/{userId}", ...LEGACY_RUNTIME }, async (event) => {
  const before = event.data?.before.data() as UserDoc | undefined;
  const after  = event.data?.after.data()  as UserDoc | undefined;
  if (!before || !after) return;
  if (before.profileUpdatedAt?.isEqual(after.profileUpdatedAt)) return;
  await rescorePairs(event.params.userId, after);
});

// Play profile edits rescore too (Stage 2: the Play fields no longer live
// on the root doc, so editing them doesn't touch profileUpdatedAt there).
export const onPlayProfileWrite = onDocumentUpdated({ document: "users/{userId}/playProfile/data", ...LEGACY_RUNTIME }, async (event) => {
  const before = event.data?.before.data();
  const after  = event.data?.after.data();
  if (!before || !after) return;
  const stamp = (d: admin.firestore.DocumentData) => JSON.stringify(d.profileUpdatedAt ?? d.lastUpdated ?? null);
  if (stamp(before) === stamp(after)) return;
  const root = (await admin.firestore().doc(`users/${event.params.userId}`).get()).data() as UserDoc | undefined;
  if (root) await rescorePairs(event.params.userId, root);
});

// Matching preferences (age range, attraction, dealbreakers, physical
// preferences — Stage 3's private/matching) and intent (private/profile)
// feed the Spark score but live off the root doc, so editing them doesn't
// touch profileUpdatedAt there. Rescore when a field scoring reads changes.
const SCORED_PRIVATE_FIELDS = [
  "intent",
  "attractedTo", "matchableAs", "ageMin", "ageMax", "drinkingHabit",
  "dealbreakers", "seekingBodyTypes", "seekingHeightMinCm", "seekingHeightMaxCm",
  "religion", "politicalView",
  // §4.A2: gender is matched on (prefMatchesGender) and lives here now.
  "genderIdentity",
] as const;

async function rescoreOnPrivateChange(
  userId: string,
  before: admin.firestore.DocumentData | undefined,
  after: admin.firestore.DocumentData | undefined,
): Promise<void> {
  if (!after) return;
  const changed = SCORED_PRIVATE_FIELDS.some((f) => JSON.stringify(before?.[f] ?? null) !== JSON.stringify(after[f] ?? null));
  if (!changed) return;
  const root = (await admin.firestore().doc(`users/${userId}`).get()).data() as UserDoc | undefined;
  if (root) await rescorePairs(userId, root);
}

export const onPrivateProfileWrite = onDocumentWritten({ document: "users/{userId}/private/profile", ...LEGACY_RUNTIME }, async (event) => {
  await rescoreOnPrivateChange(event.params.userId, event.data?.before.data(), event.data?.after.data());
});

export const onMatchingPrefsWrite = onDocumentWritten({ document: "users/{userId}/private/matching", ...LEGACY_RUNTIME }, async (event) => {
  await rescoreOnPrivateChange(event.params.userId, event.data?.before.data(), event.data?.after.data());
});
