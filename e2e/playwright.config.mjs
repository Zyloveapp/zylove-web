// Zylove web regression suite. Serial (one emulator state), fresh data per test.
// Test-only secrets come from e2e/.env.test (see .env.test.example).
import { existsSync, readFileSync } from 'node:fs'
const ENV = new URL('./.env.test', import.meta.url)
if (existsSync(ENV)) {
  for (const line of readFileSync(ENV, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim()
  }
}

export default {
  testDir: '.',
  // tests/ is the suite; tools/ (screenshots) runs only when named.
  testMatch: process.argv.some((a) => a.includes('tools/')) ? /tools\/.*\.spec\.mjs/ : /tests\/.*\.spec\.mjs/,
  workers: 1,
  fullyParallel: false,
  timeout: 120000,
  expect: { timeout: 15000 },
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'results.json' }]],
  use: { actionTimeout: 15000, navigationTimeout: 30000, baseURL: 'http://localhost:5409', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  outputDir: './test-results',
}
