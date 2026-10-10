// onTap, moved verbatim from the mobile codebase's index.ts (base snapshot,
// lines 191-268) into its own file; only its imports and the pinned runtime
// settings (legacyOptions.ts) are new.
import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { calculateSparkScore, calculatePlayScore, deepFitRecord, SCORE_ENGINE_VERSION, sparkBreakdownFor, sparkBreakdownRecord, sparkPairFields, sparkScoreFor, sparkViews } from "./scoring";
import { UserDoc, PairDoc, pairId } from "./types";
import { LEGACY_RUNTIME } from "./legacyOptions";
import { bothHavePlay, loadPlayScores, playFields, playTapAnswer, setPlayScores } from "../pairPlay";
import { scoringDocs } from "./onProfileWrite";
import { loadMatching, requireActive, withPrivateProfile } from "../userData";
import { atLeast, tierNow } from "../entitlements";
import { loadSparkDetails, writeSparkDetails } from "../pairSpark";
import { requireUidOfPlayId } from "../playIds";
import { requirePlayAccess } from "../playAccess";
import { requireAvailableTarget } from "../likes";
import { takeRateLimit } from "../rateLimits";
import { isUidShape, ownDealbreakers } from "../tapGuards";

export const onTap = onCall(LEGACY_RUNTIME, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");
  await requireActive(request.auth.uid);

  const db       = admin.firestore();
  const tapperId = request.auth.uid;
  // F-090: every tap reads and may score a pair — a generous cap that someone
  // browsing never meets, before any Play ID is resolved.
  await takeRateLimit(tapperId, "tap", { max: 300, windowMs: 10 * 60 * 1000 });
  // F-062: a Play card is known by its Play ID — the answer then carries only
  // Play scores (no pair id, nothing from Spark).
  const playTap = request.data?.tappedPlayId !== undefined;
  if (playTap) await requirePlayAccess(tapperId);
  const tappedId: string = playTap ? await requireUidOfPlayId(request.data.tappedPlayId, tapperId) : request.data?.tappedUserId;

  if (!isUidShape(tappedId)) throw new HttpsError("invalid-argument", "tappedUserId required");
  if (tapperId === tappedId) throw new HttpsError("invalid-argument", "Cannot tap yourself");
  // F-090: nothing about someone who's gone, suspended or blocked either way
  // (the same refusal as onLike).
  await requireAvailableTarget(tapperId, tappedId, playTap ? "play" : "spark");

  const pid     = pairId(tapperId, tappedId);
  const pairRef = db.collection("pairs").doc(pid);

  // Stage C / engine v2: everyone sees the score (Deep Fit's headline) and
  // its label; Spark+ the breakdown and dealbreakers; Elite Deep Fit's detail
  // (tier1: both directions, the reasons, the archetype). F-098: Play the
  // same — Spark+ its breakdown, Elite its archetype (playTapAnswer).
  // No paid feature ever involves a bot: a bot's report is shown in full.
  const tier = await tierNow(tapperId);
  const bot = tappedId.startsWith("zbot-");
  const full = bot || atLeast(tier, "spark_plus");
  const deep = bot || tier === "elite";

  // F-064/F-065: a Play tap is answered from Play state only (playPairData,
  // keyed by Play IDs) — it never creates or scores pairs/{uidA_uidB}; and a
  // Spark tap never carries Play scores (matching the two would link them).
  if (playTap) {
    if (!(await bothHavePlay(tapperId, tappedId))) throw new HttpsError("failed-precondition", "That profile isn't available.");
    const cached = await loadPlayScores(tapperId, tappedId);
    if (cached && cached.engineVersion === SCORE_ENGINE_VERSION) return playTapAnswer(cached, { full, deep });
    const [tapperSnap, tappedSnap] = await Promise.all([db.doc(`users/${tapperId}`).get(), db.doc(`users/${tappedId}`).get()]);
    if (!tapperSnap.exists || !tappedSnap.exists) throw new HttpsError("failed-precondition", "That profile isn't available.");
    const [mine, theirs] = await Promise.all([
      scoringDocs(tapperId, (tapperSnap.data() ?? {}) as UserDoc),
      scoringDocs(tappedId, (tappedSnap.data() ?? {}) as UserDoc),
    ]);
    const result = calculatePlayScore(mine.full, theirs.full);
    const fields = { ...playFields(result.score, result.breakdown, result.tier1), engineVersion: SCORE_ENGINE_VERSION };
    await setPlayScores(tapperId, tappedId, fields);
    return playTapAnswer(fields, { full, deep });
  }
  // F-090: of the triggered dealbreakers, only the tapper's own are shown
  // (tapGuards.ts ownDealbreakers) — the other person's are their private
  // matching preferences. A bot's report is shown in full.
  const myDealbreakers = (await loadMatching(tapperId)).dealbreakers;
  const visibleDealbreakers = (d: unknown) => (bot ? (Array.isArray(d) ? d : []) : ownDealbreakers(d, myDealbreakers));

  // Whether the tapped person has physical preferences to score against
  // (Stage 3: their preferences are private; the app only needs yes/no to
  // hide the physical categories otherwise).
  const tappedPrefs = await loadMatching(tappedId);
  const hasPhysicalPrefs = (Array.isArray(tappedPrefs.seekingBodyTypes) && tappedPrefs.seekingBodyTypes.length > 0) ||
    Boolean(tappedPrefs.seekingHeightMinCm) || Boolean(tappedPrefs.seekingHeightMaxCm);

  // Return the cached score if the pair exists and was scored by the current
  // engine; older engine versions are re-scored below (merged into the doc).
  const existing = await pairRef.get();
  if (existing.exists && (existing.data() as PairDoc).engineVersion === SCORE_ENGINE_VERSION) {
    const data = existing.data() as PairDoc;
    const details = full ? await loadSparkDetails(pid, tapperId, data) : null;
    return {
      pairId:     pid,
      sparkScore: sparkScoreFor(data, tapperId) ?? data.sparkScore,
      sparkEnoughInfo: data.sparkEnoughInfo !== false,
      engineVersion: data.engineVersion,
      breakdown:  { ...(details && { spark: details.sparkBreakdown }) },
      triggeredDealbreakers: visibleDealbreakers(details?.triggeredDealbreakers),
      ...(deep && details?.tier1Spark ? { tier1: details.tier1Spark } : {}),
      hasPhysicalPrefs,
      locked: !full,
    };
  }

  const [tapperSnap, tappedSnap] = await Promise.all([
    db.collection("users").doc(tapperId).get(),
    db.collection("users").doc(tappedId).get(),
  ]);

  if (!tapperSnap.exists || !tappedSnap.exists) {
    throw new HttpsError("not-found", "User profile not found");
  }

  // Scoring compares intents, which live in the owner-only private/profile (Stage 2).
  const tapperDoc  = await withPrivateProfile(tapperId, tapperSnap.data() ?? {}) as UserDoc;
  const tappedDoc  = await withPrivateProfile(tappedId, tappedSnap.data() ?? {}) as UserDoc;

  const spark = calculateSparkScore(tapperDoc, tappedDoc);
  const { triggeredDealbreakers } = spark;
  // F-119: each person's own score, dealbreaker bar and Deep Fit.
  const views = sparkViews(tapperDoc, tappedDoc, tapperId, tappedId);
  const mine = views[tapperId];
  const sparkScore = mine.score;
  const sparkBreakdown = sparkBreakdownRecord(spark, tapperId, tappedId);
  const sparkTier1 = deepFitRecord(spark.tier1, tapperId, tappedId);

  const [userA, userB] = [tapperId, tappedId].sort();

  const batch = db.batch();
  if (existing.exists) {
    // Re-score from an older engine: keep everything else on the pair
    // (likes, reveals, match state).
    batch.update(pairRef, {
      ...sparkPairFields(spark, views),
      scoreCalculatedAt: admin.firestore.Timestamp.now(),
      scoreVersion:      admin.firestore.FieldValue.increment(1),
    });
  } else {
    const pairData: PairDoc = {
      userA,
      userB,
      createdAt:         admin.firestore.Timestamp.now(),
      ...sparkPairFields(spark, views),
      scoreCalculatedAt: admin.firestore.Timestamp.now(),
      scoreVersion:      1,
    };
    batch.set(pairRef, pairData);
  }
  writeSparkDetails(batch, pid, { breakdown: sparkBreakdown, dealbreakers: triggeredDealbreakers, tier1: sparkTier1, views }, false);
  await batch.commit();

  return {
    pairId: pid,
    sparkScore,
    sparkEnoughInfo: spark.enoughInfo,
    engineVersion: SCORE_ENGINE_VERSION,
    // F-098: the physical bar is the tapper's own direction.
    breakdown: { ...(full && { spark: { ...sparkBreakdownFor(sparkBreakdown, tapperId), dealbreakers: mine.dealbreakers } }) },
    triggeredDealbreakers: full ? visibleDealbreakers(triggeredDealbreakers) : [],
    ...(deep && mine.tier1 ? { tier1: mine.tier1 } : {}),
    hasPhysicalPrefs,
    locked: !full,
  };
});

