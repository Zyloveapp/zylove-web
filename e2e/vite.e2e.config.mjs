// Serves the real app source with only services/firebase.ts swapped for the
// emulator version, and env from ./env (demo config, no production keys).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const HERE = dirname(fileURLToPath(import.meta.url))
// The app is the repo this suite lives in.
const WEB = join(HERE, '..')
const require = createRequire(join(WEB, 'package.json'))
const react = require('@vitejs/plugin-react').default
const EMU = join(HERE, 'firebase.emulator.ts')

export default {
  root: WEB,
  configFile: false,
  envDir: join(HERE, 'env'),
  // The app's Tailwind/PostCSS setup (configFile: false skips it otherwise).
  css: { postcss: WEB },
  define: { 'import.meta.env.VITE_BUILD_ID': JSON.stringify('e2e') },
  plugins: [
    react(),
    {
      name: 'e2e-emulator-firebase',
      enforce: 'pre',
      async resolveId(source, importer) {
        if (!importer || importer === EMU) return null
        if (!/(^|\/)firebase(\.ts)?$/.test(source) || !source.startsWith('.')) return null
        const resolved = await this.resolve(source, importer, { skipSelf: true })
        return resolved?.id === join(WEB, 'src/services/firebase.ts') ? EMU : null
      },
    },
  ],
  server: { port: 5409, strictPort: true, fs: { allow: [WEB, HERE] } },
  resolve: {
    dedupe: ['firebase', 'react', 'react-dom'],
    // firebase.emulator.ts sits outside the app: resolve its firebase/* to the app's copy.
    alias: [{ find: /^firebase\/(app|auth|firestore|functions|storage)$/, replacement: join(WEB, 'node_modules/firebase/$1') }],
  },
}
