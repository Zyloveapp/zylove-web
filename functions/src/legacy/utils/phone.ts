/**
 * Normalize a phone number to E.164 format.
 * Firebase Auth already returns E.164 via authUser.phoneNumber,
 * but user.phoneNumber stored on the Firestore user doc may have
 * been stored at different points in time with different formats.
 * This helper canonicalizes.
 */
export function normalizeE164(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (!trimmed) return null;

  // Already E.164 (starts with +, followed by digits only)
  if (/^\+[1-9]\d{6,14}$/.test(trimmed)) return trimmed;

  // Strip common formatting chars
  const digitsOnly = trimmed.replace(/[\s\-\(\)\.]/g, '');

  // If it starts with + after stripping, validate
  if (digitsOnly.startsWith('+')) {
    return /^\+[1-9]\d{6,14}$/.test(digitsOnly) ? digitsOnly : null;
  }

  // If it's 10 digits, assume US (+1) — Zylove is US-only at launch
  if (/^\d{10}$/.test(digitsOnly)) return `+1${digitsOnly}`;

  // If it's 11 digits starting with 1, add +
  if (/^1\d{10}$/.test(digitsOnly)) return `+${digitsOnly}`;

  // Unrecognized format
  return null;
}
