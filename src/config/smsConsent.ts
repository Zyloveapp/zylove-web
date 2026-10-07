// The SMS opt-in wording. The server records consent by version and stores
// its own copy of the text (functions/src/sms.ts SMS_CONSENT_TEXTS): change
// the wording → add a new version in both places, never edit one in place.
export const SMS_CONSENT_VERSION = '2026-10-07'

// Shown next to the opt-in checkbox; "SMS Terms" is linked where it's shown.
export const SMS_CONSENT_TEXT =
  'Text me match, message and account notifications from Zylove. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. See SMS Terms.'

export type SmsConsentSource = 'settings' | 'onboarding'
