// Mirror of functions/src/legal.ts LEGAL_VERSIONS (the "Last updated" dates of
// the Terms and Privacy pages, with a .N suffix for a second update on the
// same day). Bump both together; a bump shows existing
// users the change notice below (components/LegalUpdateNotice.tsx).
export const LEGAL_VERSIONS = { terms: '2026-10-07.2', privacy: '2026-10-07.4' } as const

// What the notice says about the current versions. Terms §15: material
// changes are announced in the app before they take effect; safety, security,
// fraud-prevention and legal-compliance changes may take effect immediately.
export const LEGAL_UPDATE = {
  updated: 'October 7, 2026',
  effective: 'October 7, 2026',
  changes: [
    'Share contact: once you have both sent 3 messages, you can swap a contact card (phone, Instagram, Snapchat or WhatsApp). Cards are end-to-end encrypted — Zylove can’t read them — and either of you can take them back.',
    'Phone numbers, handles and emails can’t be sent as chat messages; your device hides any that arrive. This check runs only on your device.',
    'We count contact requests (never the details) as a safety signal.',
  ],
}
