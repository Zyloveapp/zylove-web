// onLike, moved verbatim from the mobile codebase's index.ts (onLike's own snapshot,
// lines 271-524) into its own file; only its imports and the pinned runtime
// settings (legacyOptions.ts) are new.
import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { calculateSparkScore, calculatePlayScore } from "./scoring";
import { UserDoc, PairDoc, pairId } from "./types";
import { getToken, sendPush } from "./notifications";
import { LEGACY_RUNTIME } from "./legacyOptions";
import { internalRef } from "../userData";

export const onLike = onCall(LEGACY_RUNTIME, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");

  const db      = admin.firestore();
  const likerId = request.auth.uid;
  const likedId: string = request.data.likedUserId;
  const mode: string    = request.data.mode ?? "spark";

  const pid      = pairId(likerId, likedId);
  const pairRef  = db.collection("pairs").doc(pid);
  const likedRef = db.collection("users").doc(likedId);

  const likerRef = db.collection("users").doc(likerId);
  const [pairSnap, likedUserSnap, likerSnap] = await Promise.all([
    pairRef.get(), likedRef.get(), likerRef.get(),
  ]);

  if (likerSnap.data()?.isSuspended === true) {
    throw new HttpsError("permission-denied", "Account suspended");
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

    const likerDoc = likerSnap.data() as UserDoc;
    const likedDoc = likedUserSnap.data() as UserDoc;
    const likerPlay = likerPlaySnap?.exists ? likerPlaySnap.data() ?? {} : {};
    const likedPlay = likedPlaySnap?.exists ? likedPlaySnap.data() ?? {} : {};
    const likerFull = { ...likerDoc, ...likerPlay, playProfile: likerPlay } as UserDoc;
    const likedFull = { ...likedDoc, ...likedPlay, playProfile: likedPlay } as UserDoc;

    const { score: sparkScore, breakdown: sparkBreakdown, triggeredDealbreakers, tier1: sparkTier1 } = calculateSparkScore(likerDoc,  likedDoc);
    const { score: playScore,  breakdown: playBreakdown, tier1: playTier1 } = calculatePlayScore(likerFull, likedFull);

    const [userA, userB] = [likerId, likedId].sort();

    pair = {
      userA,
      userB,
      createdAt:         admin.firestore.Timestamp.now(),
      initiatedBy:       likerId,
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

    await pairRef.set(pair);
  }

  const likedUser = likedUserSnap.data() as UserDoc;
  const isUserA   = pair.userA === likerId;
  const otherLiked = isUserA ? pair.userBLiked : pair.userALiked;
  const likerField = isUserA ? "userALiked" : "userBLiked";
  const matched   = otherLiked;

  await pairRef.update({
    [likerField]: true,
    matched,
    ...(matched ? { matchedAt: admin.firestore.Timestamp.now() } : {}),
  });

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
  await db.doc(`users/${likedId}/likeQueue/${likerId}`).set({
    likerUid:              likerId,
    likedAt:               Date.now(),
    compatibilityScore:    mode === "play" ? (pair.playScore ?? 0) : (pair.sparkScore ?? 0),
    dealbreakersTriggered: pair.triggeredDealbreakers ?? [],
    istopPicks:            false,
    breakdown:             mode === "play"
      ? (pair.playBreakdown ?? {})
      : (pair.sparkBreakdown ?? {}),
    dismissed:             false,
    isExpired:             false,
    action:                "like",
    mode,
    likerProfile: {
      displayName:        likerDataForQueue.displayName    ?? "",
      age:                likerDataForQueue.age            ?? 0,
      photoURL:           likerDataForQueue.photoURLs?.[0] ?? null,
      photoURLs:          likerDataForQueue.photoURLs      ?? [],
      locationLabel:      likerDataForQueue.locationLabel  ?? "",
      intent:             likerDataForQueue.intent         ?? mode,
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

  if (matched) {
    const [userA, userB] = [likerId, likedId].sort();
    const matchId  = `${userA}_${userB}`;
    const matchRef = db.collection("matches").doc(matchId);

    // Fetch liker's user doc for participantSnapshots. likedUser was
    // already fetched above at the start of onLike. Both sides needed so
    // UI (animation + Threads row) can render name/photo without a live
    // cross-user fetch.
    const likerSnap = await db.collection("users").doc(likerId).get();
    const likerData = (likerSnap.data() ?? {}) as any;
    const likedData = (likedUser ?? {}) as any;

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
      isBot:              (pair as any).isBot === true,
      sparkScore:         pair.sparkScore ?? 0,
      playScore:          pair.playScore  ?? 0,
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
