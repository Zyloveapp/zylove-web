// onLike, moved verbatim from the mobile codebase's index.ts (onLike's own snapshot,
// lines 271-524) into its own file; only its imports and the pinned runtime
// settings (legacyOptions.ts) are new.
import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { calculateSparkScore, calculatePlayScore, deepFitRecord, SCORE_ENGINE_VERSION, sparkBreakdownRecord, sparkPairFields } from "./scoring";
import { UserDoc, PairDoc, pairId } from "./types";
import { getToken, sendPush } from "./notifications";
import { LEGACY_RUNTIME } from "./legacyOptions";
import { internalRef, isSuspendedUid, withPrivateProfile } from "../userData";
import { requirePlayAccess } from "../playAccess";
import { markActed } from "../explore";
import { bothHavePlay, loadPlayScores, playFields, setPlayScores } from "../pairPlay";
import { scoringDocs } from "./onProfileWrite";
import { blockedEitherWay, likedInMode, recordLike } from "../likes";
import { takeQuota } from "../usage";
import { writeSparkDetails } from "../pairSpark";
import { ensurePlayId, requireUidOfPlayId } from "../playIds";
import { createPlayMatch, livePlayMatchOf, matchRefOf } from "../playMatch";
import { publicPlayProfile } from "../playProfiles";
import { keptForReport } from "../behavior";
import { isLikeId, newLikeId } from "../likerPreviewCore";

export const onLike = onCall(LEGACY_RUNTIME, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");

  const likerId = request.auth.uid;
  const mode: "spark" | "play" = request.data?.mode === "play" ? "play" : "spark";
  // F-062: in Play the liked person is known by their Play ID.
  const likedId: string = mode === "play" ? await requireUidOfPlayId(request.data?.likedUserId, likerId) : request.data?.likedUserId;
  if (typeof likedId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(likedId) || likedId === likerId) {
    throw new HttpsError("invalid-argument", "likedUserId required");
  }
  return performLike(likerId, likedId, mode);
});

// §4.A3: the like itself, by uid — onLike (above) and likeBack (index.ts,
// which resolves an opaque like id to the liker server-side) both run it, so
// a like-back records, scores, matches and notifies exactly as a like does.
export async function performLike(likerId: string, likedId: string, mode: "spark" | "play") {
  const db       = admin.firestore();
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

  // F-065: a Play like never creates or reads pairs/{uidA_uidB} for its
  // state — its scores and likes are in playPairData (keyed by Play IDs).
  let pair: PairDoc | undefined;
  let playScores: admin.firestore.DocumentData | undefined;
  if (mode === "play") {
    playScores = await loadPlayScores(likerId, likedId);
    if (!playScores) {
      const [mine, theirs] = await Promise.all([
        scoringDocs(likerId, (likerSnap.data() ?? {}) as UserDoc),
        scoringDocs(likedId, (likedUserSnap.data() ?? {}) as UserDoc),
      ]);
      const result = calculatePlayScore(mine.full, theirs.full);
      playScores = { ...playFields(result.score, result.breakdown, result.tier1), engineVersion: SCORE_ENGINE_VERSION };
      await setPlayScores(likerId, likedId, playScores);
    }
  } else if (pairSnap.exists) {
    pair = pairSnap.data() as PairDoc;
  } else {
    // Inline pair creation — mirrors onTap (Spark only). Liker plays the
    // tapper role (initiatedBy: likerId). Reuses already-fetched root docs.
    // No view-counter side-effects.
    if (!likerSnap.exists || !likedUserSnap.exists) {
      throw new HttpsError("not-found", "User profile not found");
    }

    // Scoring compares intents, which live in the owner-only private/profile (Stage 2).
    const likerDoc = await withPrivateProfile(likerId, likerSnap.data() ?? {}) as UserDoc;
    const likedDoc = await withPrivateProfile(likedId, likedUserSnap.data() ?? {}) as UserDoc;

    const spark = calculateSparkScore(likerDoc, likedDoc);
    const { triggeredDealbreakers } = spark;

    const [userA, userB] = [likerId, likedId].sort();

    pair = {
      userA,
      userB,
      createdAt:         admin.firestore.Timestamp.now(),
      // Engine v2: the headline, its "Not enough info" flag and the engine version.
      ...sparkPairFields(spark),
      scoreCalculatedAt: admin.firestore.Timestamp.now(),
      scoreVersion:      1,
    };

    const pairBatch = db.batch();
    pairBatch.set(pairRef, pair);
    writeSparkDetails(pairBatch, pid, { breakdown: sparkBreakdownRecord(spark, likerId, likedId), dealbreakers: triggeredDealbreakers, tier1: deepFitRecord(spark.tier1, likerId, likedId) }, false);
    await pairBatch.commit();
  }

  const likedUser = likedUserSnap.data() as UserDoc;
  // Stage A: a match needs the other person's like in THIS mode.
  const otherLiked = await likedInMode(likedId, likerId, mode, pair);
  await recordLike(likerId, likedId, mode, likerId);
  // A live match between them stays as it is (never overwritten). F-062: a
  // Play match is its own doc (playMatches), apart from any Spark one.
  const playMatchId = mode === "play" ? await livePlayMatchOf(likerId, likedId) : null;
  const existingMatch = mode === "play"
    ? (playMatchId ? (await matchRefOf(playMatchId).get()).data() : undefined)
    : (await db.collection("matches").doc(pid).get()).data();
  const live = !!existingMatch && existingMatch.isBlocked !== true && !existingMatch.unmatchedAt;
  // T&S Phase 1: a reported chat kept for its reporter (unmatchConnection)
  // is never overwritten by a re-match while it's preserved.
  // F-069: a chat kept only by default (not for a report) gives way to a re-match.
  const preserved = keptForReport(existingMatch);
  const matched   = otherLiked && !preserved;
  const createMatch = otherLiked && !live && !preserved;

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
  // identically. compatibilityScore populated from the pair doc (richer
  // than bot's placeholder since we have the data here). Play-side profile fields aren't snapshotted —
  // LikeIntelligenceModal fetches the liker's playProfile/data subdoc
  // when needed. istopPicks stays false; Monday onDailySchedule is the
  // sole authoritative promoter. If matched is true, the batch in the
  // match block below deletes this entry — wasted I/O but the design
  // says "consume on match," and writing unconditionally keeps the
  // logic symmetric with the not-matched path.
  const likerDataForQueue = (likerSnap.data() ?? {}) as any;
  // A Play like shows the liker's Play profile — never their Spark one.
  const likerPlay = mode === "play"
    ? (await db.doc(`users/${likerId}/playProfile/data`).get()).data() ?? {}
    : null;
  // F-062: a Play like is keyed by the liker's Play ID and carries only their
  // public Play profile (and age) — no uid.
  const likerPlayId = mode === "play" ? await ensurePlayId(likerId) : null;
  const likerPublic = likerPlay && likerPlayId ? publicPlayProfile(likerId, likerPlayId, likerPlay, likerDataForQueue) : null;
  // §4.A3: the queue doc is server-only; the liked person's app knows the
  // like only by its opaque id (likeId, kept across a repeat like). F-098: no
  // breakdown or dealbreakers on it — the liker's own dealbreakers were in
  // there unfiltered; the details stay in pairs/{id}/modes/spark.
  const queueRef = db.doc(`users/${likedId}/likeQueue/${likerPlayId ?? likerId}`);
  const priorLikeId: unknown = (await queueRef.get()).get("likeId");
  await queueRef.set({
    ...(likerPlayId ? { likerPlayId, ...(likerPublic?.curated ? { curated: true } : {}) } : { likerUid: likerId }),
    likeId:                isLikeId(priorLikeId) ? priorLikeId : newLikeId(),
    likedAt:               Date.now(),
    compatibilityScore:    mode === "play" ? (playScores?.playScore ?? 0) : (pair?.sparkScore ?? 0),
    istopPicks:            false,
    dismissed:             false,
    isExpired:             false,
    action:                "like",
    mode,
    likerProfile: likerPublic ? {
      displayName:        likerPublic.playDisplayName ?? "",
      age:                likerPublic.age ?? 0,
      photoURL:           likerPublic.photoURLs?.[0] ?? null,
      photoURLs:          likerPublic.photoURLs ?? [],
      bio:                likerPublic.playBio ?? "",
      spiceLevel:         likerPublic.spiceLevel ?? null,
      playInterestTags:   likerPublic.playInterestTags ?? [],
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

  let createdMatchId: string | null = null;
  if (createMatch && mode === "play") {
    // F-062: a Play match — its own id, Play IDs only.
    const [likerP, likedP] = await Promise.all([
      db.doc(`users/${likerId}/playProfile/data`).get(),
      db.doc(`users/${likedId}/playProfile/data`).get(),
    ]);
    const snapOf = (uid: string, root: any, p: any, playId: string) => {
      const pub = publicPlayProfile(uid, playId, p ?? {}, root);
      return { displayName: pub.playDisplayName || "Someone new", photoURL: pub.photoURLs?.[0] ?? null, age: pub.age ?? null, isVerified: false, zyloveScoreTier: "" };
    };
    const now = admin.firestore.Timestamp.now();
    const [matchId, created] = await createPlayMatch({
      users: [likerId, likedId],
      pairId: pid,
      fields: (ids) => ({
        matchedAt: now,
        createdAt: now,
        matchGeneration: now.toMillis(),
        participantSnapshots: {
          [ids.get(likerId)!]: snapOf(likerId, likerSnap.data(), likerP.data(), ids.get(likerId)!),
          [ids.get(likedId)!]: snapOf(likedId, likedUser, likedP.data(), ids.get(likedId)!),
        },
        hasUnread: false,
        isBlocked: false,
        isBot: likedId.startsWith("zbot-") || likerId.startsWith("zbot-"),
        playScore: playScores?.playScore ?? 0,
        lastMessage: null,
        lastMessagePreview: null,
        lastMessageAt: null,
      }),
    });
    createdMatchId = matchId;
    const likedPlayId = await ensurePlayId(likedId);
    if (created) {
    const batch = db.batch();
    batch.set(db.doc(`users/${likerId}/matches/${matchId}`), { matchId, otherPlayId: likedPlayId, createdAt: now, mode });
    batch.set(db.doc(`users/${likedId}/matches/${matchId}`), { matchId, otherPlayId: likerPlayId, createdAt: now, mode });
    batch.delete(db.doc(`users/${likerId}/likeQueue/${likedPlayId}`));
    batch.delete(db.doc(`users/${likedId}/likeQueue/${likerPlayId}`));
    await batch.commit();
    const nameOf = async (uid: string, p: any, root: any) => publicPlayProfile(uid, await ensurePlayId(uid), p ?? {}, root).playDisplayName || "Someone";
    const [likerName, likedName] = await Promise.all([nameOf(likerId, likerP.data(), likerSnap.data()), nameOf(likedId, likedP.data(), likedUser)]);
    const [tokenLiker, tokenLiked] = await Promise.all([getToken(likerId), getToken(likedId)]);
    if (tokenLiker) await sendPush([tokenLiker], "🔥 You're entangled", `You and ${likedName} are entangled — make a move`, { screen: "matches" }).catch(() => {});
    if (tokenLiked) await sendPush([tokenLiked], "🔥 You're entangled", `You and ${likerName} are entangled — make a move`, { screen: "matches" }).catch(() => {});
    }
  } else if (createMatch) {
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
      ...(mode === "play" ? { playScore: playScores?.playScore ?? 0 } : { sparkScore: pair?.sparkScore ?? 0 }),
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

  // A — like push to receiver (only when no match was created). §4.A3: it
  // doesn't name the liker (a Free plan sees a count only; the SMS is
  // anonymous too).
  if (!matched && likedUser.notifyOnLike) {
    const receiverToken = await getToken(likedId);
    if (receiverToken) {
      const isPlay = mode === "play";
      await sendPush(
        [receiverToken],
        isPlay ? "🔥 Someone wants to play" : "✦ Someone sent you a Spark",
        isPlay ? "Someone wants to play" : "Someone sent you a Spark",
        { screen: "likes" },
      ).catch(() => {});
    }
  }

  if (mode === "play") {
    // F-062: no pair id (it's the uid pair) — just the Play match, if any.
    return { matched, matchId: matched ? (createdMatchId ?? playMatchId) : null };
  }
  return {
    matched,
    pairId:  pid,
    matchId: matched ? `${[likerId, likedId].sort().join("_")}` : null,
  };
}
