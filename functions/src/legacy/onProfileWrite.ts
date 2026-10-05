// onProfileWrite, moved verbatim from the mobile codebase's index.ts (deployed
// snapshot, lines 597-658) into its own file; only its imports and the pinned
// runtime settings (legacyOptions.ts) are new.
import * as admin from "firebase-admin";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { calculateSparkScore, calculatePlayScore } from "./scoring";
import { UserDoc, PairDoc } from "./types";
import { LEGACY_RUNTIME } from "./legacyOptions";

export const onProfileWrite = onDocumentUpdated({ document: "users/{userId}", ...LEGACY_RUNTIME }, async (event) => {
  const db     = admin.firestore();
  const before = event.data?.before.data() as UserDoc | undefined;
  const after  = event.data?.after.data()  as UserDoc | undefined;
  if (!before || !after) return;
  if (before.profileUpdatedAt?.isEqual(after.profileUpdatedAt)) return;

  const userId = event.params.userId;

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

  const BATCH_SIZE = 400;
  for (let i = 0; i < allPairs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = allPairs.slice(i, i + BATCH_SIZE);

    await Promise.all(chunk.map(async (pairSnap) => {
      const pair     = pairSnap.data() as PairDoc;
      const otherUid = pair.userA === userId ? pair.userB : pair.userA;

      const [otherSnap, otherPlaySnap] = await Promise.all([
        db.collection("users").doc(otherUid).get(),
        db.collection("users").doc(otherUid).collection("playProfile").doc("data").get().catch(() => null),
      ]);

      if (!otherSnap.exists) return;

      const otherDoc  = otherSnap.data() as UserDoc;
      const otherPlay = otherPlaySnap?.exists ? otherPlaySnap.data() ?? {} : {};
      const otherFull = { ...otherDoc, ...otherPlay } as UserDoc;

      const { score: sparkScore, breakdown: sparkBreakdown, triggeredDealbreakers, tier1: sparkTier1 } = calculateSparkScore(after,     otherDoc);
      const { score: playScore,  breakdown: playBreakdown, tier1: playTier1 } = calculatePlayScore(afterFull, otherFull);

      batch.update(pairSnap.ref, {
        sparkScore,
        sparkBreakdown,
        playScore,
        playBreakdown,
        triggeredDealbreakers,
        ...(sparkTier1 && { tier1Spark: sparkTier1 }),
        ...(playTier1 && { tier1Play: playTier1 }),
        scoreCalculatedAt: admin.firestore.Timestamp.now(),
        scoreVersion:      admin.firestore.FieldValue.increment(1),
      });
    }));

    await batch.commit();
  }
});
