// Mirror of functions/src/legal.ts LEGAL_VERSIONS (the "Last updated" dates of
// the Terms and Privacy pages, with a .N suffix for a second update on the
// same day). Bump both together; a bump shows existing
// users the change notice below (components/LegalUpdateNotice.tsx).
export const LEGAL_VERSIONS = { terms: '2026-10-07.2', privacy: '2026-10-07.6' } as const

// What the notice says about the current versions. Terms §15: material
// changes are announced in the app before they take effect; safety, security,
// fraud-prevention and legal-compliance changes may take effect immediately.
export const LEGAL_UPDATE = {
  updated: 'October 7, 2026',
  effective: 'October 7, 2026',
  changes: [
    'Duplicate-photo checks: we make a fingerprint (not an image) of each profile photo to spot the same photo on another account, or photos from accounts banned for scams. A match goes to a person for review.',
    'Photo fingerprints are kept while the photo exists — for an account banned for scams, as long as the ban stands.',
  ],
}
