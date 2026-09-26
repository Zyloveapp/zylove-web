import { auth } from './firebase';
import { signInWithPhoneNumber, RecaptchaVerifier, type ConfirmationResult, type UserCredential } from 'firebase/auth';

let recaptchaVerifier: RecaptchaVerifier | null = null;

export function initRecaptcha(): void {
  if (recaptchaVerifier) {
    recaptchaVerifier.clear();
    recaptchaVerifier = null;
  }
  recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
    size: 'invisible',
    callback: () => {},
    'error-callback': () => {},
  });
}

export async function sendOtp(phoneNumber: string): Promise<ConfirmationResult> {
  if (!recaptchaVerifier) initRecaptcha();
  try {
    return await signInWithPhoneNumber(auth, phoneNumber, recaptchaVerifier!);
  } catch (err) {
    recaptchaVerifier?.clear();
    recaptchaVerifier = null;
    throw err;
  }
}

export async function confirmOtp(confirmation: ConfirmationResult, code: string): Promise<UserCredential> {
  return confirmation.confirm(code);
}

export function clearRecaptcha(): void {
  recaptchaVerifier?.clear();
  recaptchaVerifier = null;
}
