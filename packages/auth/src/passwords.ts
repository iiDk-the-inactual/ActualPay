/**
 * Password hashing (Argon2id) and policy.
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet minimum for
 * Argon2id: 19 MiB memory, 2 iterations, 1 lane. They are stored in each
 * hash, so raising them later only affects new hashes; `needsRehash` lets
 * login upgrade old hashes transparently.
 */
import { hash, verify, type Algorithm } from '@node-rs/argon2';
import { AppError } from '@actualpay/shared';

/** `Algorithm.Argon2id` in @node-rs/argon2 (an ambient const enum, so referenced by value). */
// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- const enums cannot be imported under verbatimModuleSyntax
const ARGON2ID = 2 as Algorithm;

const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;
const PARAMS_MARKER = `m=${ARGON2_OPTIONS.memoryCost},t=${ARGON2_OPTIONS.timeCost},p=${ARGON2_OPTIONS.parallelism}`;

export const PASSWORD_MIN_LENGTH = 12;
/** Upper bound prevents hashing multi-megabyte "passwords" as a DoS. */
export const PASSWORD_MAX_LENGTH = 128;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, { ...ARGON2_OPTIONS, algorithm: ARGON2ID });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  if (password.length > PASSWORD_MAX_LENGTH) return false;
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export function needsRehash(passwordHash: string): boolean {
  return !passwordHash.startsWith('$argon2id$') || !passwordHash.includes(PARAMS_MARKER);
}

let dummyHash: Promise<string> | undefined;
/**
 * A real hash of a random value. Login verifies against it when the account
 * does not exist, so "no such user" costs the same time as "wrong password"
 * and response timing does not reveal which emails are registered.
 */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(`dummy-${Math.random().toString(36)}-${Date.now()}`);
  return dummyHash;
}

const COMMON_PASSWORDS = new Set([
  'password1234',
  'password12345',
  '123456789012',
  'qwertyuiopas',
  'iloveyou1234',
  'administrator',
  'letmein12345',
  'welcome12345',
  'changeme1234',
  'passw0rd1234',
]);

/**
 * Length-based policy per NIST SP 800-63B: no composition rules, a minimum
 * length, a maximum that allows passphrases, and a deny-list. Integration
 * with a breached-password service is a documented future option.
 */
export function assertPasswordAcceptable(password: string, context: { email?: string } = {}): void {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    throw AppError.validation(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw AppError.validation(`Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  }
  const lowered = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lowered) || /^(.)\1+$/.test(password)) {
    throw AppError.validation('This password is too common. Choose a longer, unique passphrase.');
  }
  if (context.email) {
    // Only the full address or the bare local part is rejected. A substring
    // rule would be absurd for short local parts (an "a@x.com" user could
    // never use the letter "a").
    const email = context.email.toLowerCase();
    const localPart = email.split('@')[0] ?? '';
    if (lowered.includes(email) || lowered === localPart) {
      throw AppError.validation('Password must not be or contain your email address.');
    }
  }
}
