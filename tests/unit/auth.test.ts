import { describe, expect, it } from 'vitest';
import { Secret, TOTP } from 'otpauth';
import { randomBytes } from 'node:crypto';
import {
  API_KEY_SCOPES,
  assertPasswordAcceptable,
  generateApiKey,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  hashRecoveryCode,
  needsRehash,
  normalizeEmail,
  parseApiKey,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  SecretBox,
  verifyPassword,
  verifyTotp,
} from '@actualpay/auth';
import { sanitizeAuditMetadata } from '@actualpay/audit';

describe('SecretBox (AES-256-GCM)', () => {
  const box = new SecretBox(randomBytes(32), 'test');

  it('round-trips and uses a fresh IV each time', () => {
    const a = box.seal('JBSWY3DPEHPK3PXP', 'totp:user-1');
    const b = box.seal('JBSWY3DPEHPK3PXP', 'totp:user-1');
    expect(a).not.toBe(b);
    expect(box.open(a, 'totp:user-1')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('refuses ciphertext moved to another context (row/purpose binding)', () => {
    const sealed = box.seal('secret', 'totp:user-1');
    expect(() => box.open(sealed, 'totp:user-2')).toThrow();
  });

  it('detects tampering', () => {
    const sealed = box.seal('secret', 'ctx');
    const parts = sealed.split('.');
    const ct = Buffer.from(parts[2]!, 'base64url');
    ct[0] = ct[0]! ^ 1;
    parts[2] = ct.toString('base64url');
    expect(() => box.open(parts.join('.'), 'ctx')).toThrow();
  });

  it('derives purpose-specific keys from one master key', () => {
    const key = randomBytes(32);
    const sealed = new SecretBox(key, 'totp').seal('x', 'ctx');
    expect(() => new SecretBox(key, 'wallet').open(sealed, 'ctx')).toThrow();
  });
});

describe('passwords', () => {
  it('hashes with Argon2id and verifies', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(needsRehash(hash)).toBe(false);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'wrong horse battery staple')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });

  it('enforces length-based policy without composition rules', () => {
    expect(() => {
      assertPasswordAcceptable('short');
    }).toThrow(/at least 12/);
    expect(() => {
      assertPasswordAcceptable('a'.repeat(129));
    }).toThrow(/at most/);
    expect(() => {
      assertPasswordAcceptable('password1234');
    }).toThrow(/too common/);
    expect(() => {
      assertPasswordAcceptable('aaaaaaaaaaaaaaa');
    }).toThrow(/too common/);
    expect(() => {
      assertPasswordAcceptable('me grayson@example.com', { email: 'grayson@example.com' });
    }).toThrow(/email/);
    expect(() => {
      assertPasswordAcceptable('graysonsmith1', { email: 'graysonsmith1@example.com' });
    }).toThrow(/email/);
    // Short local parts must not poison ordinary passphrases.
    expect(() => {
      assertPasswordAcceptable('an admin passphrase here', { email: 'admin@example.com' });
    }).not.toThrow();
    expect(() => {
      assertPasswordAcceptable('lowercase only passphrase');
    }).not.toThrow();
  });
});

describe('normalizeEmail', () => {
  it('trims and lower-cases but keeps provider-specific parts', () => {
    expect(normalizeEmail('  Alice.Smith+Shop@Example.COM ')).toBe('alice.smith+shop@example.com');
    expect(() => normalizeEmail('not-an-email')).toThrow();
  });
});

describe('TOTP', () => {
  const secret = generateTotpSecret();
  const codeAt = (ms: number) =>
    new TOTP({
      secret: Secret.fromBase32(secret),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    }).generate({ timestamp: ms });

  it('accepts the current code and refuses to reuse its time step', () => {
    const now = Date.now();
    const step = verifyTotp({ secret, code: codeAt(now), lastUsedStep: null, now });
    expect(step).not.toBeNull();
    expect(verifyTotp({ secret, code: codeAt(now), lastUsedStep: step, now })).toBeNull();
  });

  it('tolerates one step of clock skew but not more', () => {
    const now = Date.now();
    expect(
      verifyTotp({ secret, code: codeAt(now - 30_000), lastUsedStep: null, now }),
    ).not.toBeNull();
    expect(verifyTotp({ secret, code: codeAt(now - 120_000), lastUsedStep: null, now })).toBeNull();
  });

  it('rejects malformed codes', () => {
    expect(verifyTotp({ secret, code: 'abcdef', lastUsedStep: null })).toBeNull();
    expect(verifyTotp({ secret, code: '12345', lastUsedStep: null })).toBeNull();
  });
});

describe('recovery codes', () => {
  it('generates unique codes and hashes them case/dash-insensitively', () => {
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    const code = codes[0]!;
    expect(hashRecoveryCode(code.toLowerCase().replace(/-/g, ''))).toBe(hashRecoveryCode(code));
  });
});

describe('API key format', () => {
  it('round-trips and never stores the secret', () => {
    const generated = generateApiKey('testnet');
    expect(generated.key.startsWith('apk_test_')).toBe(true);
    const parsed = parseApiKey(generated.key);
    expect(parsed).toEqual({
      mode: 'test',
      publicId: generated.publicId,
      secretHash: generated.secretHash,
    });
    expect(generated.secretHash).not.toContain(generated.key.split('_')[3]!);
    expect(generateApiKey('mainnet').key.startsWith('apk_live_')).toBe(true);
  });

  it('rejects malformed keys', () => {
    expect(parseApiKey('apk_test_short_secret')).toBeNull();
    expect(parseApiKey('Bearer apk_test_x')).toBeNull();
  });
});

describe('RBAC', () => {
  it('owner and admin hold every permission; viewer is read-only', () => {
    expect([...ROLE_PERMISSIONS.owner].sort()).toEqual([...PERMISSIONS].sort());
    expect([...ROLE_PERMISSIONS.viewer].every((p) => p.endsWith(':read'))).toBe(true);
  });

  it('API key scopes exclude organization administration', () => {
    for (const scope of API_KEY_SCOPES) expect(PERMISSIONS).toContain(scope);
    for (const adminPerm of [
      'member:manage',
      'apikey:manage',
      'apikey:read',
      'org:update',
      'settings:manage',
      'withdrawal:approve',
      'audit:read',
    ]) {
      expect(API_KEY_SCOPES as readonly string[]).not.toContain(adminPerm);
    }
  });

  it('only finance, admin and owner can request withdrawals', () => {
    const can = Object.entries(ROLE_PERMISSIONS)
      .filter(([, p]) => p.has('withdrawal:create'))
      .map(([r]) => r)
      .sort();
    expect(can).toEqual(['admin', 'finance', 'owner']);
  });
});

describe('audit metadata sanitizer', () => {
  it('redacts secret-looking keys at any depth and stringifies bigint', () => {
    const out = sanitizeAuditMetadata({
      password: 'x',
      nested: { apiSecret: 'y', amount: 5n },
      list: [{ token: 'z' }],
      name: 'ok',
    });
    expect(out).toEqual({
      password: '[REDACTED]',
      nested: { apiSecret: '[REDACTED]', amount: '5' },
      list: [{ token: '[REDACTED]' }],
      name: 'ok',
    });
  });
});
