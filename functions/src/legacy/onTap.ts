// onTap, moved verbatim from the mobile codebase's index.ts (base snapshot,
// lines 191-268) into its own file; only its imports and the pinned runtime
// settings (legacyOptions.ts) are new.
import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { calculateSparkScore, calculatePlayScore } from "./scoring";
import { UserDoc, PairDoc, pairId } from "./types";
import { LEGACY_RUNTIME } from "./legacyOptions";

export const onTap = onCall(LEGACY_RUNTIME, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");

  const db       = admin.firestore();
  const tapperId = request.auth.uid;
  const tappedId: string = request.data.tappedUserId;

  if (!tappedId) throw new HttpsError("invalid-argument", "tappedUserId required");
  if (tapperId === tappedId) throw new HttpsError("invalid-argument", "Cannot tap yourself");

  const pid     = pairId(tapperId, tappedId);
  const pairRef = db.collection("pairs").doc(pid);

  // Return cached score if pair already exists
  const existing = await pairRef.get();
  if (existing.exists) {
    const data = existing.data() as PairDoc;
    return {
      pairId:     pid,
      sparkScore: data.sparkScore,
      playScore:  data.playScore,
      breakdown:  { spark: data.sparkBreakdown, play: data.playBreakdown },
      triggeredDealbreakers: data.triggeredDealbreakers ?? [],
      ...(data.tier1Spark && { tier1: data.tier1Spark }),
    };
  }

  // Fetch Spark profiles (root user docs) + Play profiles (subcollection) in parallel
  const [tapperSnap, tappedSnap, tapperPlaySnap, tappedPlaySnap] = await Promise.all([
    db.collection("users").doc(tapperId).get(),
    db.collection("users").doc(tappedId).get(),
    db.collection("users").doc(tapperId).collection("playProfile").doc("data").get().catch(() => null),
    db.collection("users").doc(tappedId).collection("playProfile").doc("data").get().catch(() => null),
  ]);

  if (!tapperSnap.exists || !tappedSnap.exists) {
    throw new HttpsError("not-found", "User profile not found");
  }

  const tapperDoc  = tapperSnap.data() as UserDoc;
  const tappedDoc  = tappedSnap.data() as UserDoc;
  const tapperPlay = tapperPlaySnap?.exists ? tapperPlaySnap.data() ?? {} : {};
  const tappedPlay = tappedPlaySnap?.exists ? tappedPlaySnap.data() ?? {} : {};

  // Merge Play profile fields into user doc for scoring
  // Spark scoring uses root doc fields only
  // Play scoring uses merged doc (Play fields override root where present)
  const tapperFull = { ...tapperDoc, ...tapperPlay, playProfile: tapperPlay } as UserDoc;
  const tappedFull = { ...tappedDoc, ...tappedPlay, playProfile: tappedPlay } as UserDoc;

  const { score: sparkScore, breakdown: sparkBreakdown, triggeredDealbreakers, tier1: sparkTier1 } = calculateSparkScore(tapperDoc,  tappedDoc);
  const { score: playScore,  breakdown: playBreakdown, tier1: playTier1 } = calculatePlayScore(tapperFull, tappedFull);

  const [userA, userB] = [tapperId, tappedId].sort();

  const pairData: PairDoc = {
    userA,
    userB,
    createdAt:         admin.firestore.Timestamp.now(),
    initiatedBy:       tapperId,
    sparkScore,
    sparkBreakdown,
    playScore,
    playBreakdown,
    triggeredDealbreakers,
    ...(sparkTier1 && { tier1Spark: sparkTier1 }),
    ...(playTier1 && { tier1Play: playTier1 }),
    scoreCalculatedAt: admin.firestore.Timestamp.now(),
    scoreVersion:      1,
    userALiked:        false,
    userBLiked:        false,
    matched:           false,
  };

  await pairRef.set(pairData);

  return { pairId: pid, sparkScore, playScore, breakdown: { spark: sparkBreakdown, play: playBreakdown }, triggeredDealbreakers, tier1: sparkTier1 };
});
