import { auth, functions } from './firebase';
import { httpsCallable } from 'firebase/functions';
import { signInWithPhoneNumber, RecaptchaVerifier, type ConfirmationResult, type UserCredential } from 'firebase/auth';

let recaptchaVerifier: RecaptchaVerifier | null = null;
let recaptchaInitialized = false;

// clear() on an invisible verifier leaves its widget in the DOM, and reCAPTCHA
// refuses to render twice into one element — so each verifier gets a fresh
// child of #recaptcha-container.
function freshRecaptchaElement(): HTMLElement | string {
  const container = document.getElementById('recaptcha-container');
  if (!container) return 'recaptcha-container';
  container.replaceChildren();
  const el = document.createElement('div');
  container.appendChild(el);
  return el;
}

export function initRecaptcha(): void {
  if (recaptchaInitialized && recaptchaVerifier) return;
  if (recaptchaVerifier) {
    recaptchaVerifier.clear();
    recaptchaVerifier = null;
  }
  recaptchaInitialized = false;
  recaptchaVerifier = new RecaptchaVerifier(auth, freshRecaptchaElement(), {
    size: 'invisible',
    callback: () => {},
    'error-callback': () => {},
  });
  recaptchaInitialized = true;
}

export async function sendOtp(phoneNumber: string): Promise<ConfirmationResult> {
  if (!recaptchaVerifier) initRecaptcha();
  try {
    return await signInWithPhoneNumber(auth, phoneNumber, recaptchaVerifier!);
  } catch (err) {
    clearRecaptcha();
    throw err;
  }
}

export async function confirmOtp(confirmation: ConfirmationResult, code: string): Promise<UserCredential> {
  return confirmation.confirm(code);
}

export function clearRecaptcha(): void {
  recaptchaVerifier?.clear();
  recaptchaVerifier = null;
  recaptchaInitialized = false;
}

// Twilio Lookup line-type check before the OTP is sent (VoIP, virtual and
// landline numbers are blocked). Fails open: if the check itself can't run,
// sign-in proceeds.
export async function checkPhoneNumber(phoneNumber: string): Promise<boolean> {
  try {
    const { data } = await httpsCallable<{ phoneNumber: string }, { allowed: boolean; reason?: string }>(
      functions,
      'validatePhoneNumber',
    )({ phoneNumber });
    return data.allowed !== false;
  } catch {
    return true;
  }
}
