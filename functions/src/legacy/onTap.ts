// onTap, moved verbatim from the mobile codebase's index.ts (base snapshot,
// lines 191-268) into its own file; only its imports and the pinned runtime
// settings (legacyOptions.ts) are new.
import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { calculateSparkScore, calculatePlayScore } from "./scoring";
import { UserDoc, PairDoc, pairId } from "./types";
import { LEGACY_RUNTIME } from "./legacyOptions";
import { bothHavePlay, loadPlayScores, playFields, setPlayScores } from "../pairPlay";
import { loadMatching, requireActive, withPrivateProfile } from "../userData";
import { atLeast, tierNow } from "../entitlements";
import { loadSparkDetails, writeSparkDetails } from "../pairSpark";

export const onTap = onCall(LEGACY_RUNTIME, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");
  await requireActive(request.auth.uid);

  const db       = admin.firestore();
  const tapperId = request.auth.uid;
  const tappedId: string = request.data.tappedUserId;

  if (!tappedId) throw new HttpsError("invalid-argument", "tappedUserId required");
  if (tapperId === tappedId) throw new HttpsError("invalid-argument", "Cannot tap yourself");

  const pid     = pairId(tapperId, tappedId);
  const pairRef = db.collection("pairs").doc(pid);

  // Stage 2 (Play sealing): Play scores only when both people have Play
  // access, and kept in pairs/{id}/modes/play — never on the pair doc.
  const play = await bothHavePlay(tapperId, tappedId);
  // Whether the tapped person has physical preferences to score against
  // (Stage 3: their preferences are private; the app only needs yes/no to
  // hide the physical categories otherwise).
  const tappedPrefs = await loadMatching(tappedId);
  const hasPhysicalPrefs = (Array.isArray(tappedPrefs.seekingBodyTypes) && tappedPrefs.seekingBodyTypes.length > 0) ||
    Boolean(tappedPrefs.seekingHeightMinCm) || Boolean(tappedPrefs.seekingHeightMaxCm);

  // Stage C: Free sees the score; Spark+ the full report (breakdown,
  // dealbreakers); Elite also Deep Fit (tier1).
  // No paid feature ever involves a bot: a bot's report is shown in full.
  const tier = await tierNow(tapperId);
  const bot = tappedId.startsWith("zbot-");
  const full = bot || atLeast(tier, "spark_plus");
  const deep = bot || tier === "elite";

  // Return cached score if pair already exists
  const existing = await pairRef.get();
  if (existing.exists) {
    const data = existing.data() as PairDoc;
    const playScores = play ? await loadPlayScores(pid, data) : undefined;
    const details = full ? await loadSparkDetails(pid, data) : null;
    return {
      pairId:     pid,
      sparkScore: data.sparkScore,
      ...(playScores && { playScore: playScores.playScore }),
      breakdown:  { ...(details && { spark: details.sparkBreakdown }), ...(playScores && { play: playScores.playBreakdown }) },
      triggeredDealbreakers: details?.triggeredDealbreakers ?? [],
      ...(deep && details?.tier1Spark ? { tier1: details.tier1Spark } : {}),
      hasPhysicalPrefs,
      locked: !full,
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

  // Scoring compares intents, which live in the owner-only private/profile (Stage 2).
  const tapperDoc  = await withPrivateProfile(tapperId, tapperSnap.data() ?? {}) as UserDoc;
  const tappedDoc  = await withPrivateProfile(tappedId, tappedSnap.data() ?? {}) as UserDoc;
  const tapperPlay = tapperPlaySnap?.exists ? tapperPlaySnap.data() ?? {} : {};
  const tappedPlay = tappedPlaySnap?.exists ? tappedPlaySnap.data() ?? {} : {};

  // Merge Play profile fields into user doc for scoring
  // Spark scoring uses root doc fields only
  // Play scoring uses merged doc (Play fields override root where present)
  const tapperFull = { ...tapperDoc, ...tapperPlay, playProfile: tapperPlay } as UserDoc;
  const tappedFull = { ...tappedDoc, ...tappedPlay, playProfile: tappedPlay } as UserDoc;

  const { score: sparkScore, breakdown: sparkBreakdown, triggeredDealbreakers, tier1: sparkTier1 } = calculateSparkScore(tapperDoc,  tappedDoc);
  const playResult = play ? calculatePlayScore(tapperFull, tappedFull) : null;

  const [userA, userB] = [tapperId, tappedId].sort();

  const pairData: PairDoc = {
    userA,
    userB,
    createdAt:         admin.firestore.Timestamp.now(),
    sparkScore,
    scoreCalculatedAt: admin.firestore.Timestamp.now(),
    scoreVersion:      1,
  };

  const batch = db.batch();
  batch.set(pairRef, pairData);
  writeSparkDetails(batch, pid, { breakdown: sparkBreakdown, dealbreakers: triggeredDealbreakers, tier1: sparkTier1 }, false);
  await batch.commit();
  if (playResult) await setPlayScores(pid, playFields(playResult.score, playResult.breakdown, playResult.tier1));

  return {
    pairId: pid,
    sparkScore,
    ...(playResult && { playScore: playResult.score }),
    breakdown: { ...(full && { spark: sparkBreakdown }), ...(playResult && { play: playResult.breakdown }) },
    triggeredDealbreakers: full ? triggeredDealbreakers : [],
    ...(deep && sparkTier1 ? { tier1: sparkTier1 } : {}),
    hasPhysicalPrefs,
    locked: !full,
  };
});
