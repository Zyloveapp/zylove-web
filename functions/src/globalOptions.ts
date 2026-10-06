import { setGlobalOptions } from 'firebase-functions/v2'

// Defaults for every function in this codebase. Imported first in index.ts,
// so it runs before any function is defined.
//
// 256 MiB minimum: every function loads this whole codebase at cold start,
// and 128 MiB ran out of memory there (sendFounderMessage 2026-10-05;
// updateDisplayName, createPortalSession, markFounderThreadRead 2026-10-06).
// scripts/check-memory.js (predeploy) refuses anything lower.
setGlobalOptions({ memory: '256MiB' })
