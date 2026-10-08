import { randomBytes } from 'node:crypto';
import { sha256Hex } from './crypto';

// Crockford-style alphabet without easily confused characters (0/O, 1/I/L).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Ten single-use codes like `K7QMZ-2XRPA-9TWEH` (15 chars from a 31-symbol alphabet, ~74 bits). */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let raw = '';
    while (raw.length < 15) {
      for (const byte of randomBytes(32)) {
        if (byte < 248 && raw.length < 15) raw += ALPHABET.charAt(byte % ALPHABET.length);
      }
    }
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}`);
  }
  return codes;
}

/** Hash in canonical form so users can type codes with or without dashes, in any case. */
export function hashRecoveryCode(code: string): string {
  return sha256Hex(code.toUpperCase().replace(/[^A-Z0-9]/g, ''));
}
