// Mirrors src/services/scamRules.ts in the web app — keep in sync.
//
// T&S Phase 2 — scam patterns in chat messages. The app runs these on the
// recipient's device (a banner under a matching message; nothing leaves the
// device); the server runs them only on what people send to curated
// profiles (bot scam traps, where messages are plaintext). Advisory: the
// banner says "This message mentions…", never "this person is a scammer".
//
// Each rule is a category; a message is scam-like when it hits a strong rule
// or two weak ones.

const R = (s: string) => new RegExp(s, 'i')

export type ScamCategory =
  | 'code'
  | 'giftCard'
  | 'moneyRequest'
  | 'crypto'
  | 'offPlatform'
  | 'leavingApp'
  | 'investmentPitch'
  | 'overseas'
  | 'urgency'

export const SCAM_RULES: Record<ScamCategory, { strong: boolean; rx: RegExp }> = {
  // Strong.
  code: {
    strong: true,
    rx: R(String.raw`\b(?:send|give|tell|share|read|forward)\b[^.?!]{0,30}\b(?:code|verification|otp|6[- ]?digit|pin)\b|\b(?:code|otp)\b[^.?!]{0,20}\b(?:you(?:'ll)?\s+(?:get|got|receive)|texted|sent)\s+(?:to\s+)?you`),
  },
  giftCard: {
    strong: true,
    rx: R(String.raw`\b(?:gift\s*cards?|itunes\s*cards?|google\s*play\s*cards?|steam\s*cards?|apple\s*cards?|amazon\s*cards?)\b`),
  },
  moneyRequest: {
    strong: true,
    // "me" only after a money verb ("venmo me", "lend me") — "send me a pic" isn't money.
    rx: R(String.raw`\b(?:lend|loan|wire|cash\s*app|venmo|zelle|paypal)\s+me\b|\b(?:send|lend|loan|wire|transfer|cash\s*app|venmo|zelle|paypal)\b[^.?!]{0,25}\b(?:money|\$\s?\d+|\d+\s?(?:dollars|bucks|usd))\b|\b(?:need|borrow)\b[^.?!]{0,20}\b(?:money|\$\s?\d+|\d+\s?(?:dollars|bucks))\b`),
  },
  crypto: {
    strong: false,
    rx: R(String.raw`\b(?:crypto|bitcoin|btc|usdt|ethereum|binance|coinbase|forex|trading\s+platform|investment\s+(?:platform|opportunity)|mining\s+pool|guaranteed\s+(?:returns?|profit))\b`),
  },
  // Naming another messenger — common and innocent alone.
  offPlatform: { strong: false, rx: R(String.raw`\b(?:whats\s?app|telegram|google\s*chat|hangouts|signal|kik|line\s+app|wechat)\b`) },
  // Pushing to leave the app — with a messenger name, the classic move.
  leavingApp: {
    strong: false,
    rx: R(String.raw`\b(?:talk|chat|text|move)\b[^.?!]{0,20}\b(?:off|outside)\s+(?:this|the)\s+app\b|\bi(?:'m| am)\s+(?:rarely|not\s+often|hardly\s+ever|barely)\s+on\s+(?:here|this\s+app)\b|\b(?:deleting|leaving)\s+(?:this|the)\s+app\b`),
  },
  // An investment pitch: crypto/trading plus an offer to show, teach or earn.
  investmentPitch: {
    strong: true,
    rx: R(String.raw`\b(?:crypto|bitcoin|btc|usdt|forex|trading|investment|mining)\b[^.?!]{0,60}\b(?:show\s+you|teach\s+you|help\s+you\s+(?:earn|invest|make)|make\s+(?:you\s+)?money|profits?|returns?|platform)\b|\b(?:show\s+you|teach\s+you|make\s+good\s+money)\b[^.?!]{0,60}\b(?:crypto|bitcoin|trading|forex|investment)\b`),
  },
  overseas: {
    strong: false,
    rx: R(String.raw`\b(?:deployed|oil\s+rig|offshore|peacekeeping|un\s+mission|stationed\s+(?:in|at|overseas)|working\s+overseas|engineer\s+(?:in|on)\s+(?:a\s+)?(?:ship|rig)|widow(?:er)?\s+with)\b`),
  },
  urgency: {
    strong: false,
    rx: R(String.raw`\b(?:urgent(?:ly)?|emergency|hospital\s+bill|stuck\s+at\s+(?:the\s+)?airport|customs\s+fee|frozen\s+account|right\s+now\s+please|asap)\b`),
  },
}

export function scamCheck(text: string): { flagged: boolean; hits: ScamCategory[] } {
  const hits = (Object.keys(SCAM_RULES) as ScamCategory[]).filter((k) => SCAM_RULES[k].rx.test(text))
  return { flagged: hits.some((k) => SCAM_RULES[k].strong) || hits.length >= 2, hits }
}

// The sentence (or ≤200 characters) around the first hit — the excerpt a
// bot scam trap keeps for review.
export function scamExcerpt(text: string, hits: ScamCategory[]): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  for (const k of hits) {
    const m = SCAM_RULES[k].rx.exec(clean)
    if (!m) continue
    const start = Math.max(0, clean.lastIndexOf('.', m.index) + 1, m.index - 100)
    return clean.slice(start, start + 200).trim()
  }
  return clean.slice(0, 200)
}

// Links: plain text for everyone; accounts under 48 hours can't send them
// (sender's device), and a recipient sees a safety note on one from an
// account that was under 48 hours old when it was sent.
const LINK_RX = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|net|org|io|me|co|app|link|ly|gg)(?:\/\S*)?\b|\b(?:wa\.me|t\.me)\/\S+/i
export function hasLink(text: string): boolean {
  return LINK_RX.test(text)
}
export const NEW_ACCOUNT_MS = 48 * 60 * 60 * 1000

// A message that is (or carries) a one-time code: the composer asks before
// sending it.
export function looksLikeCode(text: string): boolean {
  const t = text.trim()
  return /^\d{4,8}$/.test(t.replace(/[\s-]/g, '')) || /\b(?:code|otp|pin)\b[^\d]{0,15}\b\d{4,8}\b/i.test(t)
}
