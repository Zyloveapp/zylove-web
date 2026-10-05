# Security findings

One row per finding. **Source**: who found it (Jester = Claude Code in this repo; GPT = outside reviewer). **Verdict**: real / false positive / accepted (risk accepted by Matthew). **Status**: open / in progress / fixed / accepted.

Severity: **Critical** (exploitable now, exposes contact info, precise location or intimate data broadly) · **High** (broad exposure of sensitive data or a privilege bypass) · **Medium** (limited exposure, needs another condition) · **Low** (hardening).

| # | Finding | Source | Severity | Verdict | Status | Fix / commit |
|---|---|---|---|---|---|---|
| F-001 | Raw GPS (`_location`, 13–15 dp) and 7-char `geohash` (~150 m) on public `users/{uid}` — 4 real users, 40 bots; readable by any signed-in user | Jester | Critical | real | fixed | Scrubbed 2026-10-05 (`scripts/scrub-raw-location.mjs`, backup `backups/pre-location-scrub`); `coordsOf` no longer reads `_location`; bot seeder no longer writes it — `e9e15ee`. Mobile still writes both (flagged; not live). |
| F-002 | Phone number (`smsConsent.phone`) on public `users/{uid}` | Jester | Critical | real | in progress | Stage 1 → `users/{uid}/private/account`, consent via server callable |
| F-003 | Push token (`expoPushToken`) on public `users/{uid}` — anyone could push to that device | Jester | High | real | in progress | Stage 1 → `userInternal/{uid}` |
| F-004 | Intimate Play data readable by any signed-in user, Spark-only included: `playProfile/*` (acts, arrangement, place, prompts.turnOn / fantasy / dealBreaker, vibe) and `play*` fields on the root doc | Jester | Critical | real | open | Stage 2 — move `play*` off root; rules require the viewer's own Play access |
| F-005 | Snapped location (`locationLat/Lng`, ~3 mi) on public doc; Explore, profile labels and chat compute distance on the viewer's client from the other user's coordinates | Jester | High | real | in progress | Stage 1 — `userLocations/{uid}` (server-only), `setLocation`, `getDistances` (whole-mile buckets); Stage 3 server-side Explore |
| F-006 | Exact date of birth (`birthday`) public | Jester | High | real | in progress | Stage 1 → `private/account`; public `age` kept fresh server-side |
| F-007 | Payment internals public: `stripeCustomerId`, `subscriptionSource`, `subscriptionGrantedAt`; `stripeCustomerId` also client-writable | Jester | High | real | in progress | Stage 1 → `userInternal/{uid}` |
| F-008 | Trust & safety data public: `reportCount`, `sparkScore`, `zyloveScore` points, `pendingPhotoURLs` (unmoderated photos), photo rejection data | Jester | High | real | in progress | Stage 1 → `userInternal` / `private/account` (owner sees own pending photos) |
| F-009 | `isAdmin` is a doc field (public; reveals admins); admin checks read it | Jester | Medium | real | in progress | Stage 1 → custom auth claim `admin` |
| F-010 | Activity tracking public: exact `lastActive`, view and like counts | Jester | Medium | real | in progress | Stage 1 → `private/*` |
| F-011 | Settings and consents public: SMS prefs, quiet hours incl. timezone, photo-analysis consents, push-permission flag | Jester | Medium | real | in progress | Stage 1 → `private/settings` |
| F-012 | Internal state public: profile-review results, AI generation counters, onboarding/legacy flags | Jester | Low | real | in progress | Stage 1 → `userInternal` / `private/settings` |
| F-013 | Matching preferences public (needed only for filtering): `attractedTo`, `openTo`, `matchableAs`, `openToCrossover`, `seeking*`, `dealbreakers`, `ageMin/Max`, `radiusMiles`, `intentionAnswers`, `drinkingHabit`, `showOrientation` | Jester | Medium | real | open | Stage 3 — server-side Explore |
| F-014 | `isSuspended` on public doc | Jester | Low | accepted (for now) | open | Reveals nothing (suspended docs are unreadable); rules and Explore index depend on it. Moves in Stage 3 |
| F-015 | Founder claim trusts client-sent coordinates (`assignFounderBadge` takes lat/lng from the request) | Jester | Medium | real | in progress | Stage 1 — use the stored `userLocations` market |
| F-016 | Trial market derived from client-written coordinates (spoofable pre-launch pass) | Jester | Medium | real | in progress | Stage 1 — `marketCityId` locked server-side at first `setLocation` |
| F-017 | Firestore rules and indexes deployable from two repos (mobile and web) — a mobile deploy would overwrite web's rules | Jester | Medium | real | in progress | Ownership moved to `zylove-web` (Stage 1 A). Mobile repo untouched; don't deploy rules from it |
| F-018 | Displayed sensitive fields (gender identity, pronouns, religion, politics, relationship status, kids, height, body type) — confirm every one can be left blank or hidden | Matthew | Medium | — | open | Review after Stage 3 |
