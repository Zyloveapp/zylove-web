// onProfileWrite, moved verbatim from the mobile codebase's index.ts (deployed
// snapshot, lines 597-658) into its own file; only its imports and the pinned
// runtime settings (legacyOptions.ts) are new.
import * as admin from "firebase-admin";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { calculateSparkScore, calculatePlayScore } from "./scoring";
import { UserDoc, PairDoc } from "./types";
import { LEGACY_RUNTIME } from "./legacyOptions";
import { bothHavePlay, playFields, setPlayScores } from "../pairPlay";
import { isSuspendedUid, withPrivateProfile } from "../userData";

// Rescores every pair of userId. Spark scores on the pair doc; Play scores
// (Stage 2) in pairs/{id}/modes/play, and only while both people have Play
// access — otherwise any Play scores are removed.
async function rescorePairs(userId: string, afterRoot: UserDoc): Promise<void> {
  const db = admin.firestore();
  // A deleted or suspended account isn't rescored (deletion removes its Play
  // scores; a rescore racing it must not write them back).
  if ((afterRoot as any).isDeleted === true || (await isSuspendedUid(userId, afterRoot as any))) return;
  // Scoring compares intents, which live in the owner-only private/profile (Stage 2).
  const after = await withPrivateProfile(userId, afterRoot) as UserDoc;

  // Fetch updated user's Play profile for accurate Play rescoring
  const playSnap = await db.collection("users").doc(userId)
    .collection("playProfile").doc("data").get().catch(() => null);
  const playData = playSnap?.exists ? playSnap.data() ?? {} : {};
  const afterFull = { ...after, ...playData } as UserDoc;

  const [asA, asB] = await Promise.all([
    db.collection("pairs").where("userA", "==", userId).get(),
    db.collection("pairs").where("userB", "==", userId).get(),
  ]);

  const allPairs = [...asA.docs, ...asB.docs];
  if (!allPairs.length) return;

  const BATCH_SIZE = 200;
  for (let i = 0; i < allPairs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = allPairs.slice(i, i + BATCH_SIZE);

    await Promise.all(chunk.map(async (pairSnap) => {
      const pair     = pairSnap.data() as PairDoc;
      const otherUid = pair.userA === userId ? pair.userB : pair.userA;

      const [otherSnap, otherPlaySnap, play] = await Promise.all([
        db.collection("users").doc(otherUid).get(),
        db.collection("users").doc(otherUid).collection("playProfile").doc("data").get().catch(() => null),
        bothHavePlay(userId, otherUid),
      ]);

      if (!otherSnap.exists || otherSnap.data()?.isDeleted === true) return;

      const otherDoc  = await withPrivateProfile(otherUid, otherSnap.data() ?? {}) as UserDoc;
      const otherPlay = otherPlaySnap?.exists ? otherPlaySnap.data() ?? {} : {};
      const otherFull = { ...otherDoc, ...otherPlay } as UserDoc;

      const { score: sparkScore, breakdown: sparkBreakdown, triggeredDealbreakers, tier1: sparkTier1 } = calculateSparkScore(after,     otherDoc);

      batch.update(pairSnap.ref, {
        sparkScore,
        sparkBreakdown,
        triggeredDealbreakers,
        ...(sparkTier1 && { tier1Spark: sparkTier1 }),
        // Older pair docs carried the Play scores; they live in the subdoc now.
        playScore: admin.firestore.FieldValue.delete(),
        playBreakdown: admin.firestore.FieldValue.delete(),
        tier1Play: admin.firestore.FieldValue.delete(),
        scoreCalculatedAt: admin.firestore.Timestamp.now(),
        scoreVersion:      admin.firestore.FieldValue.increment(1),
      });
      if (play) {
        const { score, breakdown, tier1 } = calculatePlayScore(afterFull, otherFull);
        setPlayScores(pairSnap.id, playFields(score, breakdown, tier1), batch);
      } else {
        setPlayScores(pairSnap.id, null, batch);
      }
    }));

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
