# Deploy checklist (zylove-web)

Everything deploys from this repo only — functions (codebase `web`), Firestore
rules and indexes, Storage rules. Never from the mobile repo.

## Before
- [ ] Full regression suite passes on the code being deployed.
- [ ] Functions: run the deploy planner (dry run). Only creates and in-place
      updates — stop on any delete or delete-and-recreate.
- [ ] Rules: review the diff against what's live.
- [ ] Migrations: backup first (Firestore export; copy any Storage files the
      migration deletes), dry run, review, then apply.
- [ ] Order: functions → client push → rules → backup → migration.

## Right after each step
- [ ] Real sign-in works (dev account, email/password).
- [ ] After any functions deploy: `onBeforeSignIn`'s blocking-function URI is
      the `run.app` one, every function is ACTIVE, every Cloud Run service's
      latest revision is ready.
- [ ] After any rules deploy: the live ruleset matches the repo file.
- [ ] `node scripts/scan-function-errors.mjs <deploy start time>` — no
      out-of-memory crashes, no new errors.

## 30 minutes later (every deploy)
- [ ] `node scripts/scan-function-errors.mjs <deploy start time>` again.
      Out-of-memory crashes at cold start only show up once real traffic
      reaches each function, often after the first few minutes.
      Any hit: raise that function's memory (never below 256 MiB — the code
      default in `functions/src/globalOptions.ts`, enforced by the
      `check:memory` predeploy step).
