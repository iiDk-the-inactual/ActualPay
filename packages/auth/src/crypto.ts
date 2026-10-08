/**
 * Thin wrappers over node:crypto. Nothing here invents cryptography: it
 * picks primitives (CSPRNG, SHA-256, HMAC-SHA-256, AES-256-GCM, HKDF) and
 * fixes their parameters in one reviewable place.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** URL-safe random token with `bytes` bytes of entropy (default 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Uniform random alphanumeric string (rejection sampling avoids modulo bias). */
export function randomAlphanumeric(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248 && out.length < length) out += ALNUM.charAt(byte % 62);
    }
  }
  return out;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hmacSha256Hex(key: Buffer | string, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of two strings (false on length mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Derive an independent 32-byte subkey so one master secret never serves two purposes. */
export function deriveKey(master: Buffer | string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `actualpay/${purpose}`, 32));
}

/**
 * Authenticated encryption for small secrets stored in the database
 * (TOTP seeds now; wallet material in later phases).
 *
 * Format: `v1.<iv>.<ciphertext>.<tag>` (base64url). The version prefix lets a
 * future key ring decrypt old rows during rotation. `context` is bound as
 * associated data, so a ciphertext copied to another row or purpose fails
 * to decrypt instead of being silently accepted.
 */
export class SecretBox {
  readonly #key: Buffer;

  constructor(encryptionKey: Buffer, purpose: string) {
    if (encryptionKey.length !== 32) throw new Error('SecretBox requires a 32-byte key');
    this.#key = deriveKey(encryptionKey, `secretbox/${purpose}`);
  }

  seal(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  open(sealed: string, context: string): string {
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unsupported ciphertext format');
    const [, iv, ciphertext, tag] = parts as [string, string, string, string];
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
