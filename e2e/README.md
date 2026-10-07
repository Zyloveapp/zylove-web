# Zylove web regression suite

End-to-end tests for the web app and its Cloud Functions, run against the
Firebase emulators with an offline demo project (`demo-zylove`). Nothing here
can reach production: the emulators run under their own HOME with a throwaway
service account, and the app is served with a demo Firebase config.

**The suite must pass before every deploy** (see `DEPLOY_CHECKLIST.md`).

## Setup (once)

- Node 20+, the Firebase CLI (`npm i -g firebase-tools`) and Java 21
  (`brew install openjdk@21`) for the emulators.
- `cd e2e && npm install && npx playwright install chromium`
- `cp .env.test.example .env.test` — test-only values; `.env.test` is gitignored.
- `npm --prefix ../functions install` (the suite runs the real functions build).

## Run

```sh
cd e2e
./run.sh                                  # whole suite (~4 min)
./run.sh tests/15-stage-a.spec.mjs        # one file
./run.sh -g "likeBack"                    # by test title
./run.sh tools/score-screens.spec.mjs     # score screens by plan → shots/
```

`run.sh` builds `functions/` into an emulator copy (`web-fn/`), starts the
emulators (ports 5311, 8390, 9409, 9909; hub 4610) and the app on
<http://localhost:5409>, runs Playwright, and stops everything afterwards.
Logs: `emulators.log`, `vite.log`; failures leave traces in `test-results/`
(`npx playwright show-trace <trace.zip>`).

## Writing tests

- `tests/helpers.mjs` seeds users the way production stores them
  (`seedUser`, which runs the real Stage 1a/2/3 migrations), signs in through
  the real phone flow (`signIn`), and calls callables as a user (`callAs`).
- Plans (Stage C) are decided server-side: give a test user one with
  `setPlan(uid, 'free' | 'spark_plus' | 'elite')` rather than relying on the
  background entitlement triggers.
- Data is reset before each test (`resetEmulators`); tests run serially.
- Test-only secrets go in `.env.test` (and its example), never in the code.
