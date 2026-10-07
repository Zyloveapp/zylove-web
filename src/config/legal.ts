// Mirror of functions/src/legal.ts LEGAL_VERSIONS (the "Last updated" dates of
// the Terms and Privacy pages, with a .N suffix for a second update on the
// same day). Bump both together; a bump shows existing
// users the change notice below (components/LegalUpdateNotice.tsx).
export const LEGAL_VERSIONS = { terms: '2026-10-07.2', privacy: '2026-10-07.3' } as const

// What the notice says about the current versions. Terms §15: material
// changes are announced in the app before they take effect; safety, security,
// fraud-prevention and legal-compliance changes may take effect immediately.
export const LEGAL_UPDATE = {
  updated: 'October 7, 2026',
  effective: 'October 7, 2026',
  changes: [
    'Scam protection: your app now flags messages that ask for money, gift cards or verification codes — this check runs only on your device. New accounts can’t send links for their first 48 hours.',
    'Reporting a scam: two scam reports from unrelated members suspend an account until a person reviews it — never an automatic ban.',
    'Profiles now show "Member since" and, after 5+ conversations, "Usually replies".',
    'Fake-profile checks: your signup country (country only) and checks of profile photos for AI-generated or stolen images. A match goes to a person for review.',
  ],
}
