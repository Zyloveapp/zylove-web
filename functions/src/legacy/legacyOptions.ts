// Runtime settings the mobile codebase deployed these functions with, read
// from the Cloud Functions API on 2026-10-05 (256 MiB, 60 s, max 20
// instances). The Firebase CLI doesn't carry maxInstances over when it
// updates a function, so they're pinned here: moving a function into the web
// codebase must not change how it runs. This is the only edit to the files in
// this folder; everything else is the deployed source, byte for byte.
export const LEGACY_RUNTIME = { memory: '256MiB', timeoutSeconds: 60, maxInstances: 20 } as const
