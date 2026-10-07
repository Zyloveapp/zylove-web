// Runtime settings the mobile codebase deployed these functions with, read
// from the Cloud Functions API on 2026-10-05 (256 MiB, 60 s, max 20
// instances). The Firebase CLI doesn't carry maxInstances over when it
// updates a function, so they're pinned here: moving a function into the web
// codebase must not change how it runs. The folder was the deployed source
// byte for byte until the 2026-10 scoring overhaul (engine v2: scoring.ts,
// tier1/, onTap.ts, onProfileWrite.ts); the rest still is.
export const LEGACY_RUNTIME = { memory: '256MiB', timeoutSeconds: 60, maxInstances: 20 } as const
