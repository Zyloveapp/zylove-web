// Mirrors src/services/contactDetect.ts in the web app — keep in sync.
//
// T&S Phase 3 — contact info in chat messages (the plan's Appendix A
// detector, plus Snapchat / WhatsApp phrasing). The sender's device refuses
// a message that carries any and points to "Share contact"; whatever slips
// through (an older app, mobile) is masked on the recipient's device. The
// Share contact flow is the only way to exchange details.
//
// Ordinary links are NOT contact info (links stay plain text, and accounts
// past their first 48 hours may send them — T&S Phase 2); messenger links
// (wa.me, t.me, snapchat.com/add, instagram.com/…) are.

const PLATFORMS = 'insta(?:gram)?|ig|snap(?:chat)?|sc|whats\\s?app|wa|telegram|tg|kik|discord|facebook|fb|tiktok|tt|signal|hinge|bumble|tinder|twitter|x'
// Ordinary words after "my insta is …" that aren't a handle.
const COMMON = 'dead|dying|down|broken|great|private|public|boring|new|old|not|so|too|the|really|very|kinda|empty|mostly|full|just|all|about|deactivated|gone'
const NUM_WORDS = 'zero|oh|one|two|three|four|five|six|seven|eight|nine'

export type ContactKind = 'phone' | 'spelledPhone' | 'spacedPhone' | 'email' | 'obfuscatedEmail' | 'handle' | 'phrase' | 'messengerLink'

const RX: Record<Exclude<ContactKind, 'spacedPhone'>, RegExp> = {
  // NANP groups (512) 555-0134, international +44 7700 900123, or a bare
  // 10–15 digit run. Times, prices and ranges never reach 10 digits.
  phone: /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|\+\d{1,3}[\s.-]?\d(?:[\s.-]?\d){7,13}\b|\b\d{10,15}\b/i,
  // 7+ spelled digits in a row ("five one two five five five …").
  spelledPhone: new RegExp(`\\b(?:(?:${NUM_WORDS})[\\s,.-]*){7,}\\b`, 'i'),
  email: /[\w.+-]+@[\w-]+\.[a-z]{2,}/i,
  obfuscatedEmail: /[\w.+-]+\s*(?:\(|\[)?\s*at\s*(?:\)|\])?\s*[\w-]+\s*(?:\(|\[)?\s*dot\s*(?:\)|\])?\s*(?:com|net|org|co|io|me|edu)\b/i,
  // @handle: 3+ characters, at least one letter, not an email.
  handle: /(?:^|[^\w@])@(?=[\w.]{3,})(?=[\w.]*[a-z])[\w.]+/i,
  // "my number is 512…", "my insta is jane.d", "add me on snap", "snap: jane_d22",
  // "hmu on snap", "snap me at jane_d", "whatsapp me on +44…".
  phrase: new RegExp(
    `\\bmy\\s+(?:number|cell|phone|digits)\\s*(?:is\\b|=|:)\\s*[+(]?\\d|` +
      `\\bmy\\s+(?:${PLATFORMS}|handle|user(?:name)?)\\s*(?:is\\b|=|:)\\s*@?(?!(?:${COMMON})\\b)[a-z0-9._]{3,}|` +
      `\\b(?:add|follow|find|hit)\\s+me\\s+(?:up\\s+)?on\\s+(?:${PLATFORMS})\\b|` +
      `\\bhmu\\s+on\\s+(?:${PLATFORMS})\\b|` +
      `\\b(?:text|call|dm|message|whats\\s?app|wa)\\s+me\\s+(?:at|on)\\s+(?:${PLATFORMS}|\\+?\\d)|` +
      `\\b(?:snap|sc)\\s+me\\s*(?:at\\b|:)\\s*@?[a-z0-9._-]{3,}|` +
      `\\b(?:${PLATFORMS})\\s*[:=]\\s*@?[a-z0-9._]{3,}`,
    'i',
  ),
  messengerLink: /\b(?:wa\.me|t\.me|snapchat\.com\/add|instagram\.com|tiktok\.com\/@)\/?\S*/i,
}

// "5 1 2 5 5 5 0 1 3 4": 10+ single digits with separators — unless it's
// someone counting (each digit one more than the last).
const SPACED = /(?:\b\d\b[\s.,-]{1,2}){9,}\b\d\b/g
function spacedDigitRuns(text: string): RegExpMatchArray[] {
  return [...text.matchAll(SPACED)].filter((m) => {
    const d = (m[0].match(/\d/g) ?? []).map(Number)
    return !d.every((x, i) => i === 0 || x === d[i - 1] + 1)
  })
}

export function detectContact(text: string): ContactKind[] {
  const found = (Object.keys(RX) as (keyof typeof RX)[]).filter((k) => RX[k].test(text)) as ContactKind[]
  if (spacedDigitRuns(text).length) found.push('spacedPhone')
  return found
}

export const CONTACT_MASK = '•••'

// The text with every detected piece replaced by CONTACT_MASK.
export function maskContact(text: string): string {
  let out = text
  for (const run of spacedDigitRuns(out)) out = out.replace(run[0], CONTACT_MASK)
  for (const rx of Object.values(RX)) {
    const g = new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : `${rx.flags}g`)
    // A handle keeps the character before its "@".
    out = out.replace(g, (m) => (rx === RX.handle && !m.startsWith('@') ? `${m[0]}${CONTACT_MASK}` : CONTACT_MASK))
  }
  return out
}
