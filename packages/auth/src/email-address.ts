import { AppError } from '@actualpay/shared';

/**
 * Canonical form used for storage and lookup: trimmed, Unicode NFC,
 * lower-cased. Provider-specific rewriting (dots, +tags) is deliberately not
 * applied: those are distinct deliverable addresses.
 */
export function normalizeEmail(input: string): string {
  const email = input.trim().normalize('NFC').toLowerCase();
  // Deliberately simple: real validation is "can we deliver a verification email".
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw AppError.validation('A valid email address is required.');
  }
  return email;
}
