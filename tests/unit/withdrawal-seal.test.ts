import { describe, expect, it } from 'vitest';
import { computeSeal, verifySeal, type SealFields } from '@actualpay/withdrawals';

const key = Buffer.alloc(32, 9);
const fields: SealFields = {
  withdrawalId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  assetId: 'eth',
  amount: 1_000_000_000_000_000_000n,
  feeCharged: 5n,
  destinationAddress: '0x' + 'ab'.repeat(20),
  destinationTag: null,
  approvedBy: '33333333-3333-4333-8333-333333333333',
  approvedAtMs: 1_800_000_000_000,
  expiresAtMs: 1_800_000_900_000,
  holdJournalId: '44444444-4444-4444-8444-444444444444',
};

describe('approval seal', () => {
  it('verifies the exact fields it was computed over', () => {
    const seal = computeSeal(key, fields);
    expect(seal).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySeal(key, fields, seal)).toBe(true);
    expect(computeSeal(key, fields)).toBe(seal); // deterministic
  });

  it.each([
    ['withdrawalId', { withdrawalId: '55555555-5555-4555-8555-555555555555' }],
    ['organizationId', { organizationId: '55555555-5555-4555-8555-555555555555' }],
    ['assetId', { assetId: 'btc' }],
    ['amount', { amount: 1_000_000_000_000_000_001n }],
    ['feeCharged', { feeCharged: 6n }],
    ['destinationAddress', { destinationAddress: '0x' + 'ac'.repeat(20) }],
    ['destinationTag', { destinationTag: '7' }],
    ['approvedBy', { approvedBy: '55555555-5555-4555-8555-555555555555' }],
    ['approvedAtMs', { approvedAtMs: 1_800_000_000_001 }],
    ['expiresAtMs', { expiresAtMs: 1_800_000_900_001 }],
    ['holdJournalId', { holdJournalId: '55555555-5555-4555-8555-555555555555' }],
  ] as const)('rejects a change to %s', (_name, change) => {
    const seal = computeSeal(key, fields);
    expect(verifySeal(key, { ...fields, ...change }, seal)).toBe(false);
  });

  it('rejects another key, malformed seals and delimiter smuggling', () => {
    const seal = computeSeal(key, fields);
    expect(verifySeal(Buffer.alloc(32, 8), fields, seal)).toBe(false);
    for (const bad of ['', 'zz', seal.slice(1), seal.toUpperCase(), `${seal}00`])
      expect(verifySeal(key, fields, bad)).toBe(false);
    // Moving a value across a field boundary must not produce the same canonical string.
    expect(() => computeSeal(key, { ...fields, destinationAddress: 'a|b' })).toThrow(/delimiter/);
  });

  it('refuses keys of the wrong size', () => {
    expect(() => computeSeal(Buffer.alloc(16), fields)).toThrow(/32 bytes/);
  });
});
