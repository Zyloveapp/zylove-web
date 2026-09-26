import {
  RecaptchaVerifier,
  signInWithPhoneNumber,
  type ConfirmationResult,
  type UserCredential,
} from 'firebase/auth'
import { auth } from './firebase'

const RECAPTCHA_CONTAINER_ID = 'recaptcha-container'

let verifier: RecaptchaVerifier | null = null

function getVerifier(): RecaptchaVerifier {
  if (!verifier) {
    verifier = new RecaptchaVerifier(auth, RECAPTCHA_CONTAINER_ID, { size: 'invisible' })
  }
  return verifier
}

// Resets the verifier so the next sendOtp builds a fresh one. Call after a
// failed send (a used or expired token can't be retried) and when the
// container element unmounts.
export function clearRecaptcha(): void {
  verifier?.clear()
  verifier = null
}

export async function sendOtp(phoneNumber: string): Promise<ConfirmationResult> {
  try {
    return await signInWithPhoneNumber(auth, phoneNumber, getVerifier())
  } catch (err) {
    clearRecaptcha()
    throw err
  }
}

export function confirmOtp(confirmation: ConfirmationResult, code: string): Promise<UserCredential> {
  return confirmation.confirm(code)
}
