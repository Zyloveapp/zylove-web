import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// Git hash + build time, so every build gets a distinct ID even from the same commit.
function buildId(): string {
  let hash = 'nogit'
  try {
    hash = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    // Not a git checkout (e.g. some CI); the timestamp alone is still unique.
  }
  return `${hash}-${Date.now()}`
}

// public/ is copied verbatim, so stamp the build ID into dist/sw.js after the
// build. A new ID means a new cache name and a byte-changed sw.js, which is
// what makes browsers install the new worker.
function stampServiceWorker(id: string): Plugin {
  let outDir = 'dist'
  return {
    name: 'zylove-stamp-sw',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const file = resolve(outDir, 'sw.js')
      writeFileSync(file, readFileSync(file, 'utf8').replaceAll('__BUILD_ID__', id))
    },
  }
}

const BUILD_ID = buildId()

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), stampServiceWorker(BUILD_ID)],
  define: { 'import.meta.env.VITE_BUILD_ID': JSON.stringify(BUILD_ID) },
})
