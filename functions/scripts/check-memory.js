// Predeploy guard: no function may ask for less than 256 MiB (see
// src/globalOptions.ts). Checks every explicit `memory:` in src/.
const fs = require('fs')
const path = require('path')

const MIN_MB = 256
const toMb = (v) => (v.endsWith('GiB') ? parseFloat(v) * 1024 : parseFloat(v))
const bad = []
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (p.endsWith('.ts')) {
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/memory:\s*['"](\d+(?:\.\d+)?(?:MiB|GiB))['"]/g)) {
          if (toMb(m[1]) < MIN_MB) bad.push(`${path.relative(process.cwd(), p)}:${i + 1} ${m[1]}`)
        }
      })
    }
  }
}
walk(path.join(__dirname, '..', 'src'))
if (bad.length) {
  console.error(`Functions below ${MIN_MB} MiB (out-of-memory at cold start):\n  ${bad.join('\n  ')}`)
  process.exit(1)
}
console.log(`check-memory: every explicit memory setting is ≥ ${MIN_MB} MiB`)
