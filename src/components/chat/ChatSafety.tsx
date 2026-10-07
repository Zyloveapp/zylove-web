import { hasLink, scamCheck, type ScamCategory } from '../../services/scamRules'
import type { SenderTrust } from './useChatSafety'

// T&S Phase 2 — on-device chat safety. Everything here runs on this device
// against messages it has already decrypted; nothing is sent anywhere.
//   • a banner under an incoming message that matches the shared scam
//     patterns (advisory: "This message mentions…"), with Report;
//   • a note on a link from an account that was under 48 hours old when it
//     sent it (links stay plain text for everyone);
//   • the sender side: links are held back during an account's first 48
//     hours (founders exempt), and a message that looks like a one-time code
//     asks before it goes.

const MENTIONS: Record<ScamCategory, string> = {
  code: 'a verification code',
  giftCard: 'gift cards',
  moneyRequest: 'money',
  crypto: 'crypto',
  offPlatform: 'another messaging app',
  leavingApp: 'leaving Zylove',
  investmentPitch: 'an investment',
  overseas: 'being overseas',
  urgency: 'an emergency',
}

function list(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

export function IncomingSafety({
  text,
  sentAt,
  sender,
  onReport,
}: {
  text: string
  sentAt: number | null
  sender: SenderTrust | null
  onReport: () => void
}) {
  const { flagged, hits } = scamCheck(text)
  const newLink =
    sender !== null && !sender.founder && sender.newUntil !== null && sentAt !== null && sentAt < sender.newUntil && hasLink(text)
  if (!flagged && !newLink) return null
  return (
    <div className="mt-1 max-w-[75%] space-y-1">
      {flagged && hits.includes('code') && (
        <p role="note" className="rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          🛡 Never share a verification code. Anyone who asks for one is trying to get into an account — Zylove will never ask you
          for it.
        </p>
      )}
      {flagged && (
        <p role="note" className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          ⚠️ This message mentions {list(hits.map((h) => MENTIONS[h]))}. Scammers often do. Never send money, gift cards or codes to
          someone you haven't met.{' '}
          <button type="button" onClick={onReport} className="font-semibold underline hover:text-white">
            Report
          </button>
        </p>
      )}
      {newLink && (
        <p role="note" className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs text-white/70">
          🔗 This link came from a brand-new account. Only open it if you trust it.
        </p>
      )}
    </div>
  )
}
