import { useState } from 'react'
import { createPortal } from 'react-dom'
import { CONTACT_FIELDS, cleanField, type ContactCard, type ContactCode, type ContactField } from '../../services/contactExchange'

// T&S Phase 3 — "Share contact" in a chat: choosing what goes on a card, the
// request notice with the other person's choices, and the card itself.

const SAFETY =
  "Only share with someone you trust. Once they have your details they can reach you outside Zylove — where our safety tools can't help — and you can't take back what they've saved."

// Pick which details go on this card (no email, ever).
export function ContactSheet({
  title,
  intro,
  initial,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  title: string
  intro: string
  initial: ContactCard | null
  confirmLabel: string
  busy: boolean
  error: string | null
  onConfirm: (card: ContactCard) => void
  onClose: () => void
}) {
  const [values, setValues] = useState<Record<ContactField, string>>(() => ({
    phone: initial?.phone ?? '',
    instagram: initial?.instagram ?? '',
    snapchat: initial?.snapchat ?? '',
    whatsapp: initial?.whatsapp ?? '',
  }))
  const [on, setOn] = useState<Record<ContactField, boolean>>(() => ({
    phone: !!initial?.phone,
    instagram: !!initial?.instagram,
    snapchat: !!initial?.snapchat,
    whatsapp: !!initial?.whatsapp,
  }))
  const chosen = CONTACT_FIELDS.filter((f) => on[f.id])
  const invalid = chosen.filter((f) => cleanField(f.id, values[f.id]) === null)
  const ready = chosen.length > 0 && invalid.length === 0

  function confirm() {
    if (!ready) return
    const card: ContactCard = {}
    for (const f of chosen) card[f.id] = cleanField(f.id, values[f.id]) as string
    onConfirm(card)
  }

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 backdrop-blur-sm lg:items-center lg:p-4" role="dialog" aria-modal="true" aria-labelledby="contact-sheet-title">
      <div className="max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl border border-white/10 bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-md lg:rounded-2xl lg:pb-6">
        <h2 id="contact-sheet-title" className="text-xl font-bold">
          {title}
        </h2>
        <p className="mt-1 text-sm text-white/60">{intro}</p>
        <div className="mt-4 space-y-3">
          {CONTACT_FIELDS.map((f) => (
            <div key={f.id}>
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={on[f.id]} onChange={(e) => setOn((o) => ({ ...o, [f.id]: e.target.checked }))} />
                {f.label}
              </label>
              {on[f.id] && (
                <input
                  value={values[f.id]}
                  onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                  placeholder={f.placeholder}
                  aria-label={f.label}
                  inputMode={f.id === 'phone' || f.id === 'whatsapp' ? 'tel' : 'text'}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm"
                />
              )}
              {on[f.id] && values[f.id].trim() && cleanField(f.id, values[f.id]) === null && (
                <p className="mt-1 text-xs text-red-400">That doesn't look like a {f.label.toLowerCase()}.</p>
              )}
            </div>
          ))}
        </div>
        <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">🛡 {SAFETY}</p>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={confirm} disabled={!ready || busy} className="flex-1 rounded-xl bg-[#1B4FD8] py-3 font-semibold disabled:opacity-40">
            {confirmLabel}
          </button>
          <button type="button" onClick={onClose} disabled={busy} className="rounded-xl px-4 py-3 text-white/60">
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// The server's notices in the thread; the live request gets the choices.
export function ContactNotice({
  code,
  isMine,
  partnerName,
  live,
  busy,
  onReceiveOnly,
  onShareBack,
  onDecline,
}: {
  code: ContactCode
  isMine: boolean
  partnerName: string
  live: boolean
  busy: boolean
  onReceiveOnly: () => void
  onShareBack: () => void
  onDecline: () => void
}) {
  const who = isMine ? 'You' : partnerName
  const text: Record<ContactCode, string> = {
    contact_request: isMine ? `You offered ${partnerName} your contact details.` : `${partnerName} wants to share contact details with you.`,
    contact_accepted: isMine ? 'You accepted the contact request.' : `${partnerName} accepted your contact request.`,
    contact_declined: isMine ? 'You declined the contact request.' : `${partnerName} declined. Their contact details stay private.`,
    contact_revoked: `${who} took back the contact details. They're hidden here now — but either of you may already have saved them.`,
  }
  return (
    <div className="mx-auto max-w-sm rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-center text-sm text-white/70">
      <p>🪪 {text[code]}</p>
      {live && code === 'contact_request' && !isMine && (
        <>
          <p className="mt-2 text-xs text-amber-100/80">🛡 {SAFETY}</p>
          <div className="mt-3 flex flex-col gap-2">
            <button type="button" disabled={busy} onClick={onReceiveOnly} className="rounded-lg bg-[#1B4FD8] px-3 py-2 font-semibold text-white disabled:opacity-40">
              Receive only
            </button>
            <button type="button" disabled={busy} onClick={onShareBack} className="rounded-lg bg-white/10 px-3 py-2 font-semibold text-white disabled:opacity-40">
              Receive and share mine
            </button>
            <button type="button" disabled={busy} onClick={onDecline} className="rounded-lg px-3 py-2 text-white/60 disabled:opacity-40">
              Decline
            </button>
          </div>
        </>
      )}
    </div>
  )
}

const LABEL: Record<ContactField, string> = { phone: '📞 Phone', instagram: '📸 Instagram', snapchat: '👻 Snapchat', whatsapp: '💬 WhatsApp' }

// A card (decrypted on this device), or the note that it was taken back.
export function ContactCardMessage({
  card,
  removed,
  isMine,
  partnerName,
  onTakeBack,
}: {
  card: ContactCard | null
  removed: boolean
  isMine: boolean
  partnerName: string
  onTakeBack: (() => void) | null
}) {
  if (removed || !card) {
    return (
      <p className="mx-auto max-w-xs text-center text-xs italic text-white/40">
        🪪 Contact card removed. {isMine ? `${partnerName} may have already saved it.` : 'You may have saved it already — please respect that it was taken back.'}
      </p>
    )
  }
  return (
    <div className={`max-w-[75%] rounded-2xl border px-4 py-3 ${isMine ? 'border-[#1B4FD8]/40 bg-[#1B4FD8]/15' : 'border-white/15 bg-white/10'}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-white/50">🪪 {isMine ? 'Your contact card' : `${partnerName}'s contact card`}</p>
      <dl className="mt-2 space-y-1 text-sm">
        {(Object.keys(LABEL) as ContactField[])
          .filter((f) => card[f])
          .map((f) => (
            <div key={f} className="flex flex-wrap gap-x-2">
              <dt className="text-white/50">{LABEL[f]}</dt>
              <dd className="select-all break-all font-medium">{card[f]}</dd>
            </div>
          ))}
      </dl>
      {onTakeBack && (
        <button type="button" onClick={onTakeBack} className="mt-2 text-xs text-white/50 underline hover:text-white">
          Take back contact details
        </button>
      )}
    </div>
  )
}
