import { initializeApp } from 'firebase/app'
import { ReCaptchaEnterpriseProvider, initializeAppCheck } from 'firebase/app-check'
import { browserLocalPersistence, initializeAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import { getFunctions } from 'firebase/functions'
import { getStorage } from 'firebase/storage'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

export const app = initializeApp(firebaseConfig)
export const auth = initializeAuth(app, {
  persistence: browserLocalPersistence,
})

if (import.meta.env.DEV) {
  auth.settings.appVerificationDisabledForTesting = true
}

if (import.meta.env.DEV) {
  (self as any).FIREBASE_APPCHECK_DEBUG_TOKEN = true
}

// F-082: App Check in monitor mode. Firestore, Functions, Storage and Auth
// requests carry a reCAPTCHA Enterprise attestation; nothing enforces it yet
// (no enforceAppCheck on any function, enforcement off in the console), so
// the console's metrics show verified vs unverified traffic. Off without a
// site key (local dev, previews) and for an emulator project (demo-*); the
// e2e suite also swaps this whole file for e2e/firebase.emulator.ts.
const appCheckSiteKey = import.meta.env.VITE_APPCHECK_SITE_KEY
if (appCheckSiteKey && !String(firebaseConfig.projectId ?? '').startsWith('demo-')) {
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    })
  } catch (err) {
    // Monitor mode: attestation must never stop the app from loading.
    console.warn('App Check not started', err)
  }
}

export const db = getFirestore(app)
export const storage = getStorage(app)
export const functions = getFunctions(app)
