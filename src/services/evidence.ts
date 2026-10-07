import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

// T&S Phase 4 — attaching messages to a report (functions/src/evidence.ts).
// Only the messages the reporter selects leave the device: their decrypted
// text (or photo), and the per-message franking key so the server can check
// they're genuine. The reported person is never told.

// The words shown right before evidence is sent. Matthew: swap in the
// brief's exact copy here (one place).
export const EVIDENCE_CONFIRM_COPY =
  'Only the messages you selected will be sent to the Zylove safety team, unencrypted, so a person can review your report. Nothing else from this chat leaves your device, and they won’t be told who reported them.'

export interface EvidenceCandidate {
  id: string
  from: 'me' | 'them'
  type: 'text' | 'photo'
  text: string // shown in the picker (photos: a label)
  sentAt: number | null
  revealKf: () => string | null
  // Photos: the decrypted bytes, fetched only if the reporter includes them.
  photoBytes?: () => Promise<Uint8Array | null>
}

export interface EvidenceSummary {
  items: number
  verified: number
  unverified: number
  mismatch: number
  photos: number
}

function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export async function submitEvidence(input: {
  matchId: string
  reportedUid: string
  generation: number
  items: { candidate: EvidenceCandidate; includePhoto: boolean }[]
}): Promise<{ lockerId: string; summary: EvidenceSummary }> {
  const items = []
  for (const { candidate: c, includePhoto } of input.items) {
    const photo = c.type === 'photo' && includePhoto && c.photoBytes ? await c.photoBytes() : null
    if (c.type === 'photo' && !photo) continue // a photo left out (or unreadable) isn't sent
    items.push({
      msgId: c.id,
      from: c.from === 'me' ? 'reporter' : 'reported',
      kf: c.revealKf(),
      ...(photo ? { photo: base64(photo) } : { plaintext: c.text }),
    })
  }
  const res = await httpsCallable<unknown, { lockerId: string; summary: EvidenceSummary }>(functions, 'submitEvidence')({
    matchId: input.matchId,
    reportedUid: input.reportedUid,
    ...(input.generation > 0 ? { generation: input.generation } : {}),
    items,
  })
  return res.data
}

// The reporter's own copy, made now and never stored.
export async function downloadEvidencePdf(lockerId: string): Promise<void> {
  const { data } = await httpsCallable<{ lockerId: string }, { pdf: string }>(functions, 'getEvidencePdf')({ lockerId })
  const bytes = Uint8Array.from(atob(data.pdf), (c) => c.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'zylove-report.pdf'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
