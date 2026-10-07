#!/bin/sh
# Runs the regression suite: builds the web functions into an emulator copy,
# starts the Firebase emulators (offline demo project) and the app, runs
# Playwright, and always stops everything. Extra args go to Playwright, e.g.
#   ./run.sh                                  whole suite (must pass before every deploy)
#   ./run.sh tests/15-stage-a.spec.mjs        one file
#   ./run.sh -g "likeBack"                    by title
#   ./run.sh tools/score-screens.spec.mjs     score-screen screenshots → shots/
set -e
E=$(cd "$(dirname "$0")" && pwd)
WEB=$(cd "$E/.." && pwd)
C="$E/.cache"
[ -f "$E/.env.test" ] || { echo "Missing e2e/.env.test — copy .env.test.example and fill it in."; exit 1; }
TWILIO_AUTH_TOKEN=$(sed -n 's/^TWILIO_AUTH_TOKEN=//p' "$E/.env.test")
[ -n "$TWILIO_AUTH_TOKEN" ] || { echo "TWILIO_AUTH_TOKEN missing in e2e/.env.test"; exit 1; }
mkdir -p "$C/home"
# The emulators run under their own HOME (no real gcloud/firebase login) and a
# throwaway service account for the demo project, so nothing can reach
# production. Reuse already-downloaded emulator jars if there are any.
[ -e "$C/home/.cache/firebase" ] || { [ -d "$HOME/.cache/firebase" ] && mkdir -p "$C/home/.cache" && ln -s "$HOME/.cache/firebase" "$C/home/.cache/firebase"; } || true
[ -f "$C/fake-sa.json" ] || node -e "
const { generateKeyPairSync } = require('crypto')
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
require('fs').writeFileSync(process.argv[1], JSON.stringify({ type: 'service_account', project_id: 'demo-zylove', private_key_id: 'e2e-fake', private_key: privateKey, client_email: 'e2e-fake@demo-zylove.iam.gserviceaccount.com', client_id: '0', token_uri: 'http://127.0.0.1:1/token' }))
" "$C/fake-sa.json"

# Test-only copy of the web functions build, with the admin.firestore statics
# shim the emulator needs (it proxies admin.firestore without them).
# Production deploys rebuild from functions/src and never see this copy.
(cd "$WEB/functions" && npm run build >/dev/null)
rm -rf "$E/web-fn" && mkdir -p "$E/web-fn"
cp -R "$WEB/functions/lib" "$WEB/functions/package.json" "$E/web-fn/"
ln -sfn "$WEB/functions/node_modules" "$E/web-fn/node_modules"
perl -pi -e "s/admin\.firestore\.(FieldValue|Timestamp|GeoPoint|FieldPath)\b/require('firebase-admin\/firestore').\$1/g" "$E"/web-fn/lib/legacy/*.js
printf 'TWILIO_AUTH_TOKEN=%s\n' "$TWILIO_AUTH_TOKEN" > "$E/web-fn/.secret.local"

# The repo's own rules (the emulator only reads files inside e2e/).
cp "$WEB/firestore.rules" "$WEB/storage.rules" "$C/"

# Stops the emulators and the app (by process and by port: npx and the
# firebase CLI spawn children that outlive their parent).
cleanup() {
  [ -n "$EMU" ] && kill "$EMU" 2>/dev/null
  [ -n "$VITE" ] && kill "$VITE" 2>/dev/null
  for port in 5409 5311 8390 9409 9909 4610 4710; do lsof -ti "tcp:$port" 2>/dev/null | xargs kill 2>/dev/null; done
  true
}
trap cleanup EXIT INT TERM
cleanup
(cd "$E" && exec env NODE_OPTIONS="--require $E/stub-anthropic.cjs" GOOGLE_APPLICATION_CREDENTIALS="$C/fake-sa.json" HOME="$C/home" CLOUDSDK_CONFIG="$C/home/.gcloud" \
  PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH" firebase emulators:start --project demo-zylove > "$E/emulators.log" 2>&1) &
EMU=$!
# Served from the repo root so Tailwind finds the app's sources.
(cd "$WEB" && exec npx vite --config "$E/vite.e2e.config.mjs" > "$E/vite.log" 2>&1) &
VITE=$!
i=0
until grep -qE "All emulators ready|Error:" "$E/emulators.log" 2>/dev/null; do
  i=$((i + 1)); [ $i -gt 240 ] && { echo "Emulators didn't start — see e2e/emulators.log"; exit 1; }
  sleep 1
done
grep -q "All emulators ready" "$E/emulators.log" || { grep "Error:" "$E/emulators.log" | head -3; exit 1; }
cd "$E" && npx playwright test "$@"
