import { FirebaseError } from 'firebase/app'
import { BRAND } from '../brand/zylove'
import { FieldLockedError } from './fieldLocks'

// Plain-English messages for errors shown to users. Never put a raw Firebase
// code (storage/unauthorized, permission-denied, auth/…) in front of someone.
// The original error still goes to the console for debugging.

const NETWORK = "Can't reach Zylove right now — check your connection and try again."
const GENERIC = `Something went wrong on our end. Try again in a moment — if it keeps happening, email ${BRAND.supportEmail}.`

const BY_CODE: Record<string, string> = {
  // Network / availability
  'unavailable': NETWORK,
  'deadline-exceeded': NETWORK,
  'functions/unavailable': NETWORK,
  'functions/deadline-exceeded': NETWORK,
  'storage/retry-limit-exceeded': NETWORK,
  'auth/network-request-failed': NETWORK,
  // Permissions / session
  'permission-denied': "We couldn't save that because your session needs refreshing. Sign out and back in, then try again.",
  'functions/permission-denied': "You don't have access to do that.",
  'unauthenticated': 'Your session expired. Sign in again to continue.',
  'functions/unauthenticated': 'Your session expired. Sign in again to continue.',
  'storage/unauthorized': "We couldn't upload that photo. Make sure it's a JPG or PNG under 10 MB, then try again.",
  'storage/unauthenticated': 'Your session expired. Sign in again to continue.',
  'storage/canceled': 'The upload was cancelled.',
  'storage/quota-exceeded': GENERIC,
  // Limits
  'resource-exhausted': "You've hit a limit for now. Try again a little later.",
  'functions/resource-exhausted': "You've hit a limit for now. Try again a little later.",
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/quota-exceeded': 'Too many attempts. Wait a few minutes and try again.',
  // Auth
  'auth/invalid-phone-number': "That phone number doesn't look right. Check it and try again.",
  'auth/missing-phone-number': 'Enter your phone number to continue.',
  'auth/invalid-verification-code': "That code isn't right. Check the text and try again.",
  'auth/code-expired': 'That code has expired. Request a new one.',
  'auth/captcha-check-failed': "We couldn't verify you're human. Refresh the page and try again.",
  'auth/user-disabled': `This account has been disabled. Email ${BRAND.supportEmail} if you think that's a mistake.`,
  // Data
  'not-found': "We couldn't find that. It may have been removed.",
  'functions/not-found': "We couldn't find that. It may have been removed.",
  'already-exists': 'That already exists.',
  'functions/already-exists': 'That already exists.',
  'failed-precondition': GENERIC,
  'functions/failed-precondition': GENERIC,
  'functions/internal': GENERIC,
  'internal': GENERIC,
}

// For a server error with its own user-facing message (an HttpsError thrown
// by our functions with readable text), that message is used; otherwise the
// code's message, otherwise `fallback`.
export function friendlyError(err: unknown, fallback = GENERIC): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return NETWORK
  // F-099: a field changed too recently — the date it can change again.
  if (err instanceof FieldLockedError) return err.message
  if (err instanceof FirebaseError) {
    const mapped = BY_CODE[err.code]
    // Our callables throw HttpsErrors whose message is written for users
    // ("Already rated this conversation…"); keep those for the
    // invalid-argument / failed-precondition / resource-exhausted cases.
    const serverMessage = err.code.startsWith('functions/') && err.message && !/^(internal|INTERNAL)$/.test(err.message) ? err.message : null
    if (serverMessage && ['functions/invalid-argument', 'functions/failed-precondition', 'functions/resource-exhausted', 'functions/not-found', 'functions/already-exists'].includes(err.code)) {
      return serverMessage
    }
    return mapped ?? fallback
  }
  return fallback
}

export const SUPPORT_EMAIL = BRAND.supportEmail
