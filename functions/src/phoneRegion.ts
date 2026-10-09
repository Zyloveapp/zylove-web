import { parsePhoneNumberFromString } from 'libphonenumber-js'

// F-122 (M11): US numbers only, for sign-up and for every text we send. The
// NANP +1 also covers Canada and the Caribbean (a common premium-rate
// target), so the country comes from the number plan, not the prefix. The
// emulator's test numbers (+1 555 01xx) aren't real numbers and only pass
// there.
const EMULATOR_TEST = /^\+1555\d{7}$/

export function isUsNumber(phone: string, opts: { emulator?: boolean } = {}): boolean {
  const parsed = parsePhoneNumberFromString(phone)
  if (parsed?.country === 'US' && parsed.isValid()) return true
  return (opts.emulator ?? process.env.FUNCTIONS_EMULATOR === 'true') && EMULATOR_TEST.test(phone)
}
