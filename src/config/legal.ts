// Mirror of functions/src/legal.ts LEGAL_VERSIONS (the "Last updated" dates of
// the Terms and Privacy pages, with a .N suffix for a second update on the
// same day). Bump both together; a bump shows existing
// users the change notice below (components/LegalUpdateNotice.tsx).
export const LEGAL_VERSIONS = { terms: '2026-10-07.2', privacy: '2026-10-07.2' } as const

// What the notice says about the current versions. Terms §15: material
// changes are announced in the app before they take effect; safety, security,
// fraud-prevention and legal-compliance changes may take effect immediately.
export const LEGAL_UPDATE = {
  updated: 'October 7, 2026',
  effective: 'October 7, 2026',
  changes: [
    'Safety checks: we now use counts and timing of activity (never message content) and hashed device and network data (kept 90 days) to spot fake accounts, scams and ban evasion. A person reviews every flag.',
    'Reported chats: if you report someone and the chat ends, it stays readable to you for 30 days for your report.',
    "Our team's access to accounts is logged.",
    'Terms §15: we tell you about material changes in the app before they take effect; changes needed for safety, security, fraud prevention or legal compliance may take effect immediately, with notice in the app.',
  ],
}
