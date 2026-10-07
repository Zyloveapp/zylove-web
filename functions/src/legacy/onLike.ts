// onLike, moved verbatim from the mobile codebase's index.ts (onLike's own snapshot,
// lines 271-524) into its own file; only its imports and the pinned runtime
// settings (legacyOptions.ts) are new.
import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { calculateSparkScore, calculatePlayScore } from "./scoring";
import { UserDoc, PairDoc, pairId } from "./types";
import { getToken, sendPush } from "./notifications";
import { LEGACY_RUNTIME } from "./legacyOptions";
import { internalRef, isSuspendedUid, withPrivateProfile } from "../userData";
import { requirePlayAccess } from "../playAccess";
import { markActed } from "../explore";
import { bothHavePlay, loadPlayScores, playFields, setPlayScores } from "../pairPlay";
import { blockedEitherWay, likedInMode, recordLike } from "../likes";
import { takeQuota } from "../usage";
import { loadSparkDetails, writeSparkDetails } from "../pairSpark";

export const onLike = onCall(LEGACY_RUNTIME, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");

  const db      = admin.firestore();
  const likerId = request.auth.uid;
  const likedId: string = request.data?.likedUserId;
  const mode: "spark" | "play" = request.data?.mode === "play" ? "play" : "spark";
  if (typeof likedId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(likedId) || likedId === likerId) {
    throw new HttpsError("invalid-argument", "likedUserId required");
  }

  const pid      = pairId(likerId, likedId);
  const pairRef  = db.collection("pairs").doc(pid);
  const likedRef = db.collection("users").doc(likedId);

  const likerRef = db.collection("users").doc(likerId);
  const [pairSnap, likedUserSnap, likerSnap] = await Promise.all([
    pairRef.get(), likedRef.get(), likerRef.get(),
  ]);

  if (await isSuspendedUid(likerId, likerSnap.data())) {
    throw new HttpsError("permission-denied", "Account suspended");
  }
  // Stage A: not someone who's gone, suspended or blocked (either way).
  if (!likedUserSnap.exists || (await isSuspendedUid(likedId, likedUserSnap.data())) || (await blockedEitherWay(likerId, likedId))) {
    throw new HttpsError("failed-precondition", "That profile isn't available.");
  }
  // Stage C: Free has 10 likes a day (usage.ts); Spark+ and Elite, unlimited.
  await takeQuota(likerId, "likes");
  // Stage 2: a Play like needs Play access on both sides.
  const play = await bothHavePlay(likerId, likedId);
  if (mode === "play") {
    await requirePlayAccess(likerId);
    if (!play) throw new HttpsError("failed-precondition", "That profile isn't available in Play.");
  }

  let pair: PairDoc;
  if (pairSnap.exists) {
    pair = pairSnap.data() as PairDoc;
  } else {
    // Inline pair creation — mirrors onTap. Liker plays the tapper role
    // (initiatedBy: likerId). Reuses already-fetched root docs; only the
    // Play subdocs are read here. No view-counter side-effects.
    if (!likerSnap.exists || !likedUserSnap.exists) {
      throw new HttpsError("not-found", "User profile not found");
    }

    const [likerPlaySnap, likedPlaySnap] = await Promise.all([
      db.collection("users").doc(likerId).collection("playProfile").doc("data").get().catch(() => null),
      db.collection("users").doc(likedId).collection("playProfile").doc("data").get().catch(() => null),
    ]);

    // Scoring compares intents, which live in the owner-only private/profile (Stage 2).
    const likerDoc = await withPrivateProfile(likerId, likerSnap.data() ?? {}) as UserDoc;
    const likedDoc = await withPrivateProfile(likedId, likedUserSnap.data() ?? {}) as UserDoc;
    const likerPlay = likerPlaySnap?.exists ? likerPlaySnap.data() ?? {} : {};
    const likedPlay = likedPlaySnap?.exists ? likedPlaySnap.data() ?? {} : {};
    const likerFull = { ...likerDoc, ...likerPlay, playProfile: likerPlay } as UserDoc;
    const likedFull = { ...likedDoc, ...likedPlay, playProfile: likedPlay } as UserDoc;

    const { score: sparkScore, breakdown: sparkBreakdown, triggeredDealbreakers, tier1: sparkTier1 } = calculateSparkScore(likerDoc,  likedDoc);
    const playResult = play ? calculatePlayScore(likerFull, likedFull) : null;

    const [userA, userB] = [likerId, likedId].sort();

    pair = {
      userA,
      userB,
      createdAt:         admin.firestore.Timestamp.now(),
      sparkScore,
      scoreCalculatedAt: admin.firestore.Timestamp.now(),
      scoreVersion:      1,
    };

    const pairBatch = db.batch();
    pairBatch.set(pairRef, pair);
    writeSparkDetails(pairBatch, pid, { breakdown: sparkBreakdown, dealbreakers: triggeredDealbreakers, tier1: sparkTier1 }, false);
    await pairBatch.commit();
    if (playResult) await setPlayScores(pid, playFields(playResult.score, playResult.breakdown, playResult.tier1));
  }
  const playScores = mode === "play" ? await loadPlayScores(pid, pair) : undefined;

  const likedUser = likedUserSnap.data() as UserDoc;
  // Stage A: a match needs the other person's like in THIS mode.
  const otherLiked = await likedInMode(likedId, likerId, mode, pair);
  await recordLike(pid, mode, likerId);
  // A live match between them stays as it is (never overwritten).
  const existingMatch = (await db.collection("matches").doc(pid).get()).data();
  const live = !!existingMatch && existingMatch.isBlocked !== true && !existingMatch.unmatchedAt;
  const matched   = otherLiked;
  const createMatch = otherLiked && !live;

  // Explore (Stage 3): acted on in this mode — out of the liker's deck.
  await markActed(likerId, mode as "spark" | "play", likedId);

  // Stage B: who liked whom (and whether they matched) is no longer on the
  // pair doc, which both people can read — a Spark-only partner could see a
  // Play like there. It's in pairs/{id}/likes/{mode} (server-only).

  // Skip stat write for bot profiles — avoids creating stub docs
  const isBotTarget = likedId.startsWith("seed-");
  if (!isBotTarget) {
    await internalRef(likedId).set(
      { likesReceivedCount: admin.firestore.FieldValue.increment(1) },
      { merge: true },
    );
  }

  // Write the receiver's likeQueue inbox entry. Mirrors the shape used
  // by botEngine.createLikeAndMatch so the client read path (LikeIntelligenceModal,
  // Sparks tab) treats human-originated and bot-originated likes
  // identically. compatibilityScore + breakdown + dealbreakers populated
  // from the pair doc (richer than bot's empty placeholders since we
  // have the data here). Play-side profile fields aren't snapshotted —
  // LikeIntelligenceModal fetches the liker's playProfile/data subdoc
  // when needed. istopPicks stays false; Monday onDailySchedule is the
  // sole authoritative promoter. If matched is true, the batch in the
  // match block below deletes this entry — wasted I/O but the design
  // says "consume on match," and writing unconditionally keeps the
  // logic symmetric with the not-matched path.
  const likerDataForQueue = (likerSnap.data() ?? {}) as any;
  // Stage C: the report's details live in pairs/{id}/modes/spark.
  const sparkDetails = await loadSparkDetails(pid, pair);
  // A Play like shows the liker's Play profile — never their Spark one.
  const likerPlay = mode === "play"
    ? (await db.doc(`users/${likerId}/playProfile/data`).get()).data() ?? {}
    : null;
  await db.doc(`users/${likedId}/likeQueue/${likerId}`).set({
    likerUid:              likerId,
    likedAt:               Date.now(),
    compatibilityScore:    mode === "play" ? (playScores?.playScore ?? 0) : (pair.sparkScore ?? 0),
    dealbreakersTriggered: mode === "play" ? [] : sparkDetails.triggeredDealbreakers,
    istopPicks:            false,
    breakdown:             mode === "play"
      ? (playScores?.playBreakdown ?? {})
      : sparkDetails.sparkBreakdown,
    dismissed:             false,
    isExpired:             false,
    action:                "like",
    mode,
    likerProfile: likerPlay ? {
      displayName:        likerPlay.playDisplayName ?? likerDataForQueue.playDisplayName ?? "",
      age:                likerDataForQueue.age ?? 0,
      photoURL:           likerPlay.photoURLs?.[0] ?? null,
      photoURLs:          likerPlay.photoURLs ?? [],
      bio:                likerPlay.playBio ?? "",
      spiceLevel:         likerPlay.spiceLevel ?? null,
      playInterestTags:   likerPlay.playInterestTags ?? [],
      verificationStatus: likerDataForQueue.verificationStatus ?? "unverified",
    } : {
      displayName:        likerDataForQueue.displayName    ?? "",
      age:                likerDataForQueue.age            ?? 0,
      photoURL:           likerDataForQueue.photoURLs?.[0] ?? null,
      photoURLs:          likerDataForQueue.photoURLs      ?? [],
      locationLabel:      likerDataForQueue.locationLabel  ?? "",
      intent:             mode, // never the liker's own intent (it would reveal Play use)
      verificationStatus: likerDataForQueue.verificationStatus ?? "unverified",
      bio:                likerDataForQueue.bio            ?? "",
      personalityTraits:  likerDataForQueue.personalityTraits  ?? [],
      personalityTags:    likerDataForQueue.personalityTraits  ?? [],
      topValues:          likerDataForQueue.relationshipValues ?? [],
      relationshipValues: likerDataForQueue.relationshipValues ?? [],
      lifestyleTags:      likerDataForQueue.lifestyleTags      ?? [],
      weekendVibes:       likerDataForQueue.weekendVibes       ?? [],
      loveLangGive:       likerDataForQueue.loveLangGive       ?? [],
      loveLangReceive:    likerDataForQueue.loveLangReceive    ?? [],
      promptAnswers:      likerDataForQueue.promptAnswers      ?? [],
    },
  });

  if (createMatch) {
    const [userA, userB] = [likerId, likedId].sort();
    const matchId  = `${userA}_${userB}`;
    const matchRef = db.collection("matches").doc(matchId);

    // Fetch liker's user doc for participantSnapshots. likedUser was
    // already fetched above at the start of onLike. Both sides needed so
    // UI (animation + Threads row) can render name/photo without a live
    // cross-user fetch.
    const likerSnap = await db.collection("users").doc(likerId).get();
    // A Play match snapshots both Play identities (name, first Play photo).
    const playOf = async (uid: string) =>
      mode === "play" ? ((await db.doc(`users/${uid}/playProfile/data`).get()).data() ?? {}) : null;
    const [likerP, likedP] = await Promise.all([playOf(likerId), playOf(likedId)]);
    const withPlay = (root: any, p: any) =>
      p ? { ...root, displayName: p.playDisplayName ?? root.playDisplayName ?? "Someone new", photoURLs: p.photoURLs ?? [] } : root;
    const likerData = withPlay(likerSnap.data() ?? {}, likerP);
    const likedData = withPlay(likedUser ?? {}, likedP);

    await matchRef.set({
      matchId,
      users:        [userA, userB],
      participants: [userA, userB],               // legacy fallback
      mode,
      pairId:       pid,
      matchedAt:    admin.firestore.FieldValue.serverTimestamp(),
      createdAt:    admin.firestore.Timestamp.now(),
      conversationId: matchId,                    // sorted uid join — same as matchId
      participantSnapshots: {
        [likerId]: {
          displayName:     likerData.displayName ?? "Someone new",
          photoURL:        likerData.photoURLs?.[0] ?? null,
          age:             likerData.age ?? null,
          isVerified:      false,
          zyloveScoreTier: "",
        },
        [likedId]: {
          displayName:     likedData.displayName ?? "Someone new",
          photoURL:        likedData.photoURLs?.[0] ?? null,
          age:             likedData.age ?? null,
          isVerified:      false,
          zyloveScoreTier: "",
        },
      },
      hasUnread:          false,
      isBlocked:          false,
      isBot:              likedId.startsWith("zbot-") || likerId.startsWith("zbot-"),
      // Only this mode's score (Stage 2: no Play data on Spark matches).
      ...(mode === "play" ? { playScore: playScores?.playScore ?? 0 } : { sparkScore: pair.sparkScore ?? 0 }),
      revealViewedAt:     null,
      revealViewedBy:     [],
      lastMessage:        null,
      lastMessagePreview: null,
      lastMessageAt:      null,
    });

    const batch = db.batch();
    batch.set(
      db.collection("users").doc(userA).collection("matches").doc(matchId),
      { matchId, otherUid: userB, createdAt: admin.firestore.Timestamp.now(), mode }
    );
    batch.set(
      db.collection("users").doc(userB).collection("matches").doc(matchId),
      { matchId, otherUid: userA, createdAt: admin.firestore.Timestamp.now(), mode }
    );
    // Consume both sides' likeQueue inbox entries — the "pending like"
    // notification is done once a match exists. Deletes on missing docs
    // are no-ops, so safe if one side never had an entry.
    batch.delete(db.doc(`users/${likerId}/likeQueue/${likedId}`));
    batch.delete(db.doc(`users/${likedId}/likeQueue/${likerId}`));
    await batch.commit();

    // B — match push to both users
    const [tokenA, tokenB] = await Promise.all([getToken(userA), getToken(userB)]);
    const nameA = (userA === likerId ? likerData : likedData).displayName ?? "Someone";
    const nameB = (userB === likerId ? likerData : likedData).displayName ?? "Someone";
    const isPlayMatch = mode === "play";

    if (tokenA) {
      await sendPush(
        [tokenA],
        isPlayMatch ? "🔥 You're entangled" : "✦ You have a Spark",
        isPlayMatch
          ? `You and ${nameB} are entangled — make a move`
          : `You and ${nameB} have a Spark — say something`,
        { screen: "matches" },
      ).catch(() => {});
    }
    if (tokenB) {
      await sendPush(
        [tokenB],
        isPlayMatch ? "🔥 You're entangled" : "✦ You have a Spark",
        isPlayMatch
          ? `You and ${nameA} are entangled — make a move`
          : `You and ${nameA} have a Spark — say something`,
        { screen: "matches" },
      ).catch(() => {});
    }
  }

  // A — like push to receiver (only when no match was created)
  if (!matched && likedUser.notifyOnLike) {
    const receiverToken = await getToken(likedId);
    if (receiverToken) {
      const senderName = (likerSnap.data() as any)?.displayName ?? "Someone";
      const isPlay = mode === "play";
      await sendPush(
        [receiverToken],
        isPlay ? `🔥 ${senderName} wants to play` : `✦ ${senderName} sent you a Spark`,
        isPlay ? `${senderName} wants to play` : `${senderName} sent you a Spark`,
        { screen: "likes" },
      ).catch(() => {});
    }
  }

  return {
    matched,
    pairId:  pid,
    matchId: matched ? `${[likerId, likedId].sort().join("_")}` : null,
  };
});
