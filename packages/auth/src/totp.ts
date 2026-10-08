/**
 * TOTP (RFC 6238) via the `otpauth` library: SHA-1, 6 digits, 30-second
 * period, the parameters every authenticator app supports.
 *
 * Replay protection: we return the matched time step, the caller stores it,
 * and codes at or below the stored step are rejected.
 */
import { Secret, TOTP } from 'otpauth';

const PERIOD_SECONDS = 30;

export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function totpUri(params: { secret: string; issuer: string; accountName: string }): string {
  return new TOTP({
    issuer: params.issuer,
    label: params.accountName,
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD_SECONDS,
    secret: Secret.fromBase32(params.secret),
  }).toString();
}

/**
 * Returns the accepted time step, or null. Allows ±1 step for clock skew.
 */
export function verifyTotp(params: {
  secret: string;
  code: string;
  lastUsedStep: bigint | null;
  now?: number;
}): bigint | null {
  const code = params.code.replace(/\s+/g, '');
  if (!/^[0-9]{6}$/.test(code)) return null;
  const now = params.now ?? Date.now();
  const totp = new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD_SECONDS,
    secret: Secret.fromBase32(params.secret),
  });
  const delta = totp.validate({ token: code, timestamp: now, window: 1 });
  if (delta === null) return null;
  const step = BigInt(Math.floor(now / 1000 / PERIOD_SECONDS) + delta);
  if (params.lastUsedStep !== null && step <= params.lastUsedStep) return null;
  return step;
}
