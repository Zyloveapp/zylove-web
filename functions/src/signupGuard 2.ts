// F-122 (M11): the server-side sign-up checks. validatePhoneNumber runs only
// because the web app chooses to call it before sending the code, so a script
// could skip it and sign up with a VoIP or foreign number. This blocking
// function runs on every new account, after the phone is verified:
//   - a phone number is required (no email or anonymous accounts from clients;
//     admin-created accounts don't go through blocking functions);
//   - US numbers only (the NANP +1 includes Canada and the Caribbean, where
//     premium-rate numbers are a common SMS-pumping target);
//   - VoIP, landline and other non-mobile line types are refused (Twilio
//     Lookup; a Lookup failure lets the sign-up through, so an outage can't
//     stop new accounts).
// It can't stop the sign-in code itself being sent — that's Firebase's SMS
// region policy (console: Authentication → Settings → SMS region policy,
// allow US only).

import { beforeUserCreated } from 'firebase-functions/v2/identity'
import { HttpsError } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { isUsNumber } from './phoneRegion'
import { LOOKUP_SECRETS, lookupLineType } from './sms'

// Line types that can't sign up (shared with validatePhoneNumber).
// Twilio Lookup v2 reports camelCase types; the other spellings are kept in
// case older/alternate values show up.
export const BLOCKED_LINE_TYPES = new Set([
  'landline',
  'fixedVoip',
  'nonFixedVoip',
  'tollFree',
  'voip',
  'virtual',
  'toll-free',
  'non-fixed-voip',
])

export type SignupDecision = { ok: true } | { ok: false; reason: 'no_phone' | 'not_us' | 'line_type' }

export function signupDecision(phone: string | null | undefined, lineType: string | null, opts: { emulator: boolean }): SignupDecision {
  if (!phone) return { ok: false, reason: 'no_phone' }
  if (!isUsNumber(phone, { emulator: opts.emulator })) return { ok: false, reason: 'not_us' }
  if (lineType !== null && BLOCKED_LINE_TYPES.has(lineType)) return { ok: false, reason: 'line_type' }
  return { ok: true }
}

export const SIGNUP_REFUSED: Record<Exclude<SignupDecision, { ok: true }>['reason'], string> = {
  no_phone: 'Sign up with your mobile phone number.',
  not_us: 'Zylove is only available with a US mobile number for now.',
  line_type: 'Use a mobile number — VoIP, landline and virtual numbers can’t be used.',
}

export const onBeforeCreate = beforeUserCreated(
  { timeoutSeconds: 7, memory: '256MiB', secrets: LOOKUP_SECRETS },
  async (event) => {
    const phone = event.data?.phoneNumber ?? null
    const emulator = process.env.FUNCTIONS_EMULATOR === 'true'
    // Lookup only for a US number (no point paying to refuse a foreign one).
    const early = signupDecision(phone, null, { emulator })
    const lineType = early.ok && phone ? await lookupLineType(phone, 4000) : null
    const decision = early.ok ? signupDecision(phone, lineType, { emulator }) : early
    if (!decision.ok) {
      logger.info('onBeforeCreate: refused', { reason: decision.reason, lineType })
      throw new HttpsError('permission-denied', SIGNUP_REFUSED[decision.reason])
    }
  },
)
