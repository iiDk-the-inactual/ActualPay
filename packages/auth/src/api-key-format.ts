/**
 * API key string format: `apk_<mode>_<publicId>_<secret>`
 *
 *   mode      `live` (mainnet) or `test` (testnet), so a key for one network
 *             is visibly wrong on the other and secret scanners can match it
 *   publicId  16 alphanumeric chars, stored in clear for lookup and display
 *   secret    43 base64url chars (256 bits), stored only as SHA-256
 */
import type { NetworkMode } from '@actualpay/shared';
import { randomAlphanumeric, randomToken, sha256Hex } from './crypto';

const KEY_PATTERN = /^apk_(live|test)_([A-Za-z0-9]{16})_([A-Za-z0-9_-]{43})$/;

export interface GeneratedApiKey {
  readonly key: string;
  readonly publicId: string;
  readonly secretHash: string;
  /** Safe-to-display prefix, e.g. `apk_live_AbC...`. */
  readonly displayPrefix: string;
}

export function modeFor(network: NetworkMode): 'live' | 'test' {
  return network === 'mainnet' ? 'live' : 'test';
}

export function generateApiKey(network: NetworkMode): GeneratedApiKey {
  const mode = modeFor(network);
  const publicId = randomAlphanumeric(16);
  const secret = randomToken(32);
  return {
    key: `apk_${mode}_${publicId}_${secret}`,
    publicId,
    secretHash: sha256Hex(secret),
    displayPrefix: `apk_${mode}_${publicId}`,
  };
}

export function parseApiKey(
  value: string,
): { mode: 'live' | 'test'; publicId: string; secretHash: string } | null {
  const match = KEY_PATTERN.exec(value);
  if (!match) return null;
  const [, mode, publicId, secret] = match as unknown as [string, 'live' | 'test', string, string];
  return { mode, publicId, secretHash: sha256Hex(secret) };
}
