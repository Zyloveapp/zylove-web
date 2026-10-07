// Mirror of functions/src/legal.ts LEGAL_VERSIONS (the "Last updated" dates of
// the Terms and Privacy pages, with a .N suffix for a second update on the
// same day). Bump both together; a bump shows existing
// users the change notice below (components/LegalUpdateNotice.tsx).
export const LEGAL_VERSIONS = { terms: '2026-10-07.2', privacy: '2026-10-07.5' } as const

// What the notice says about the current versions. Terms §15: material
// changes are announced in the app before they take effect; safety, security,
// fraud-prevention and legal-compliance changes may take effect immediately.
export const LEGAL_UPDATE = {
  updated: 'October 7, 2026',
  effective: 'October 7, 2026',
  changes: [
    'Reporting with evidence: you can attach the messages you choose to a report. Only those leave your device; our safety team keeps them encrypted and every view is logged. The person you report is never told.',
    'Message verification: each message now carries a fingerprint so a reported message can be confirmed as genuine. The trade-off: a message you sent that someone reports can be confirmed as yours.',
    'Appeals: if your account is suspended you can appeal once, and a person reviews it.',
    'How long we keep report evidence: 30 days after a decision (longer only for child-safety cases or legal holds).',
  ],
}
