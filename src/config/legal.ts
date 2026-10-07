// Mirror of functions/src/legal.ts LEGAL_VERSIONS (the "Last updated" dates of
// the Terms and Privacy pages). Bump both together; a bump shows existing
// users the change notice below (components/LegalUpdateNotice.tsx).
export const LEGAL_VERSIONS = { terms: '2026-10-07', privacy: '2026-10-07' } as const

// What the notice says about the current versions. Terms §15: material
// changes are announced in the app at least 14 days before they take effect.
export const LEGAL_UPDATE = {
  updated: 'October 7, 2026',
  effective: 'October 21, 2026',
  changes: [
    'Text messages: we only text sign-in codes, account and security alerts, and match and message notifications you opt in to — never marketing. New SMS Terms explain STOP and HELP.',
    'Privacy: your phone number and SMS consent are never shared with or sold to anyone for marketing.',
    'Play PIN: it is a privacy lock checked by our servers, which keep only a salted hash of it.',
  ],
}
