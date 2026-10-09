// Mirror of functions/src/legal.ts LEGAL_VERSIONS (the "Last updated" dates of
// the Terms and Privacy pages, with a .N suffix for a second update on the
// same day). Bump both together; a bump shows existing
// users the change notice below (components/LegalUpdateNotice.tsx).
export const LEGAL_VERSIONS = { terms: '2026-10-08', privacy: '2026-10-08' } as const

// What the notice says about the current versions. Terms §15: material
// changes are announced in the app before they take effect; safety, security,
// fraud-prevention and legal-compliance changes may take effect immediately.
export const LEGAL_UPDATE = {
  updated: 'October 8, 2026',
  effective: 'October 8, 2026',
  changes: [
    'Zylove curated profiles: your most recent messages to one (up to 8) go to Anthropic to write its reply, and your name and bio are used for its first message.',
    'Deleting your account: we keep a recovery record (name, birthday, gender, bio, photo links, moderation status) for 18 months so you can restore it within 90 days — as long as the ban stands for a banned account.',
    'Religion and political views are now private: never shown to other members, only used for matching. You can also hide your gender identity, and height is optional.',
    'When you delete your account, the people you were chatting with keep a read-only copy, shown as "Deleted User", for up to 12 months.',
    "Deleting your account also cancels a paid plan, the same way as cancelling it: it won't renew, and the rest of the current period isn't refunded.",
    'Chat PIN: the backup of your chat key is only as strong as your 4-digit PIN — someone with access to our database could in principle recover it. You can choose not to set one.',
  ],
}
