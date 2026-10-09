// functions/src/onBotMessage.ts
//
// Zylove — Bot Auto-Responder
//
// Triggers when a new message is written to matches/{matchId}/messages/{messageId}
// If the match is a bot match AND the message was sent by a real user (not the bot),
// the bot fires a Claude-powered reply after a short human-feeling delay.
//
// Deploy: firebase deploy --only functions:onBotMessage

import * as admin from "firebase-admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { takeQuota } from "../usage";
import { loadMatch } from "../playMatch";
import { logId } from "../logSafe";
import {
  sendPush,
  getToken,
  isQuietHours,
  isMessageCapReached,
  incrementMessageCap,
} from "./notifications";

const anthropicKey = defineSecret("ANTHROPIC_API_KEY");

function getDb() {
  return admin.firestore();
}

function buildPersonaPrompt(bot: any, mode: string = "spark", playData?: any): string {
  // F-062: in Play the bot is its Play profile — never its Spark name.
  const name = (mode === "play" ? (playData?.playDisplayName || playData?.displayName) : bot.displayName) || "Ava";
  const age = bot.age || 25;
  const job = bot.occupation || "designer";

  const bio = mode === "play"
    ? (playData?.playBio || bot.playBio || bot.bio || "")
    : (bot.bio || bot.sparkBio || "");

  const values = (bot.values || []).join(", ");

  const prompts = mode === "play"
    ? (playData?.promptAnswers || playData?.playPromptAnswers || [])
        .map((p: any) => `${p.promptId}: ${p.answer}`).join("\n")
    : (bot.promptAnswers || [])
        .map((p: any) => `${p.prompt || p.promptId}: ${p.answer}`).join("\n");

  const playContext = mode === "play" && playData ? `
Spice level: ${playData.spiceLevel ?? "not set"}
What you're into: ${(playData.playInterestTags ?? []).join(", ")}
Non-negotiables: ${(playData.playNonNegotiables ?? []).join(", ")}
` : "";

  const toneInstruction = mode === "play"
    ? "You are on the Play side of Zylove — casual, direct, confident. Keep responses flirty and genuine. Not a serious LTR context."
    : "You are on the Spark side of Zylove — looking for something real and meaningful.";

  return `You are ${name}, a ${age}-year-old ${job} in Austin, TX on a dating app called Zylove.

Your profile bio: "${bio}"
Your values: ${values || "authenticity, humor, depth"}
${prompts ? `\nYour prompt answers:\n${prompts}` : ""}${playContext}

${toneInstruction}

Respond naturally as ${name} in a real text conversation. Keep replies SHORT — 1-3 sentences max, casual and warm. Be genuinely curious about this person. Never break character. Never mention you are an AI or a bot. Never use generic filler lines like "that's so interesting!" Reference specific things from the conversation when possible. Match the energy — playful gets playful, deep gets deep. Occasional typos and casual punctuation are fine.`;
}

export const onBotMessage = onDocumentCreated(
  {
    document: "matches/{matchId}/messages/{messageId}",
    secrets: [anthropicKey],
    timeoutSeconds: 30,
    memory: "256MiB",
    // Deployed with max 20 instances; pinned (the CLI doesn't carry it over).
    maxInstances: 20,
  },
  async (event) => botReply(event.params.matchId, event.id, event.data?.data())
);

// F-062: Play bot chats (playMatches/{pm_…}): senders are Play IDs.
export const onBotPlayMessage = onDocumentCreated(
  {
    document: "playMatches/{matchId}/messages/{messageId}",
    secrets: [anthropicKey],
    timeoutSeconds: 30,
    memory: "256MiB",
    maxInstances: 20,
  },
  async (event) => botReply(event.params.matchId, event.id, event.data?.data())
);

async function botReply(matchId: string, eventId: string, message: admin.firestore.DocumentData | undefined): Promise<void> {
    const db = getDb();

    if (!message) return;

    // Don't respond to bot messages (avoid infinite loop)
    if (message.isBot === true) return;

    // Check if this is a bot match
    const ctx = await loadMatch(matchId);
    if (!ctx) return;
    const matchRef = ctx.ref;
    const match = ctx.data;
    const matchMode: string = ctx.play ? "play" : (match as any).mode ?? "spark";

    // The bot is the other participant (people by uid; ids as messages name them).
    const senderId = typeof message.senderId === "string" ? ctx.uidOf(message.senderId) : null;
    const usersList: string[] = ctx.users;
    const botUid = senderId ? usersList.find((u: string) => u !== senderId) : undefined;
    if (!senderId || !botUid) return;
    const botId = ctx.idOf(botUid);

    // Gate (Stage A): the partner must BE a bot — by uid (zbot-, or the
    // older seed-). The isBot flag alone isn't enough: a reply here is
    // written as the partner, from their profile.
    const isBotMatch = botUid.startsWith("zbot-") || botUid.startsWith("seed-");
    if (!isBotMatch || match.isBlocked === true || match.unmatchedAt) return;
    // Bot replies are AI calls — at most 30 a day per person (Stage C, usage.ts).
    const underLimit = await takeQuota(senderId, "botReplies").then(() => true, () => false);
    if (!underLimit) return;

    // Fetch bot persona
    const botDoc = await db.collection("users").doc(botUid).get();
    if (!botDoc.exists) return;
    const bot = botDoc.data()!;

    let botPlayData: any = null;
    if (matchMode === "play") {
      const playSnap = await db
        .collection("users").doc(botUid)
        .collection("playProfile").doc("data").get();
      if (playSnap.exists) botPlayData = playSnap.data();
    }

    // Fetch recent message history (last 8 messages for context)
    const historySnap = await matchRef
      .collection("messages")
      .orderBy("sentAt", "desc")
      .limit(8)
      .get();

    // T&S Phase 1: real text messages only — never system notes, consent
    // codes or photo messages.
    const history = historySnap.docs
      .reverse()
      .filter((d) => {
        const msg = d.data();
        return (msg.messageType ?? "text") === "text" && msg.nonce !== "system";
      })
      .map((d) => {
        const msg = d.data();
        return {
          role: msg.senderId === botId ? "assistant" : "user",
          content: String(msg.ciphertext || "").slice(0, 2000),
        };
      })
      .filter((m) => m.content);

    // Call Claude
    const apiKey = anthropicKey.value();

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 150,
        system: buildPersonaPrompt(bot, matchMode, botPlayData),
        messages: history,
      }),
    });

    const data = (await response.json()) as any;
    const replyText = data?.content?.[0]?.text;
    // Log Anthropic failures explicitly so retired models / 401s / rate
    // limits surface in Cloud Function logs instead of silently returning.
    // The prior bug (claude-sonnet-4-20250514 retired → 404 → no content
    // → silent return) ate every bot reply with no log breadcrumb.
    if (!replyText) {
      console.error("[onBotMessage] Anthropic call returned no content", {
        matchId: logId(matchId),
        status: response.status,
        errorType: data?.error?.type,
        errorMessage: data?.error?.message,
      });
      return;
    }

    // Human-feeling delay — 2 to 6 seconds
    const delay = 2000 + Math.random() * 4000;
    await new Promise((resolve) => setTimeout(resolve, delay));

    // Write bot reply — deterministic doc ID keyed on event.id makes this
    // idempotent. Firebase onDocumentCreated has at-least-once delivery,
    // so retries will upsert the same doc instead of duplicating.
    await matchRef
      .collection("messages")
      .doc(`bot_${eventId}`)
      .set({
        senderId: botId,
        ciphertext: replyText,
        nonce: "stub",
        messageType: "text",
        status: "sent",
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        isBot: true,
      });

    // Update match preview — generic, like a person's (the app decrypts the
    // real preview itself; plaintext never sits on the match doc).
    await matchRef.update({
      lastMessagePreview: "New message",
      lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
      hasUnread: true,
    });

    // C — Push to the human user (with quiet hours + 3/day cap).
    if (!isQuietHours()) {
      const humanUid = usersList.find(
        (u: string) => !u.startsWith("zbot-") && !u.startsWith("seed-"),
      );
      if (humanUid) {
        const capReached = await isMessageCapReached(humanUid);
        if (!capReached) {
          const token = await getToken(humanUid);
          if (token) {
            const botName = (matchMode === "play" ? (botPlayData?.playDisplayName || botPlayData?.displayName) : (bot as any)?.displayName) ?? "Someone";
            const preview = replyText.slice(0, 60);
            const isPlay = matchMode === "play";
            await sendPush(
              [token],
              isPlay ? "🔥 Something's ignited" : "✦ New message",
              isPlay
                ? `Something's ignited with ${botName} · ${preview}`
                : `Your connection with ${botName} is alive · ${preview}`,
              { screen: `chat/${matchId}` },
            ).catch(() => {});
            await incrementMessageCap(humanUid);
          }
        }
      }
    }
}