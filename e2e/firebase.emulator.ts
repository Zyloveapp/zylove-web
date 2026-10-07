// Test-only stand-in for src/services/firebase.ts: same exports, wired to the
// local emulators (demo-zylove). Swapped in by vite.e2e.config.mjs.
import { initializeApp } from 'firebase/app'
import { browserLocalPersistence, connectAuthEmulator, initializeAuth } from 'firebase/auth'
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore'
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions'
import { connectStorageEmulator, getStorage } from 'firebase/storage'

export const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
})
export const auth = initializeAuth(app, { persistence: browserLocalPersistence })
auth.settings.appVerificationDisabledForTesting = true
connectAuthEmulator(auth, 'http://127.0.0.1:9409', { disableWarnings: true })
export const db = getFirestore(app)
connectFirestoreEmulator(db, '127.0.0.1', 8390)
export const storage = getStorage(app)
connectStorageEmulator(storage, '127.0.0.1', 9909)
export const functions = getFunctions(app)
connectFunctionsEmulator(functions, '127.0.0.1', 5311)
