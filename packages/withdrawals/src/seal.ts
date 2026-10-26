/**
 * The approval seal.
 *
 * When a human approves a withdrawal, the API computes an HMAC over everything
 * that matters (who, what, where, how much, until when, and the ledger hold) with
 * a key that is NOT in the database. The signer holds the same key and refuses
 * any withdrawal whose seal does not verify.
 *
 * Effect: someone who can only write to the database (SQL injection, a leaked
 * database credential, a malicious DBA) cannot make the signer pay out, because
 * they cannot produce a valid seal. It does not defend against an attacker who
 * controls the API process itself; the human approval with two-factor
 * authentication, the destination cool-down and the limits are what stand in
 * that case (docs/withdrawals.md states this plainly).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SealFields {
  readonly withdrawalId: string;
  readonly organizationId: string;
  readonly assetId: string;
  readonly amount: bigint;
  readonly feeCharged: bigint;
  readonly destinationAddress: string;
  readonly destinationTag: string | null;
  readonly approvedBy: string;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
  readonly holdJournalId: string;
}

function canonical(f: SealFields): string {
  const parts = [
    'actualpay.withdrawal.v1',
    f.withdrawalId,
    f.organizationId,
    f.assetId,
    f.amount.toString(),
    f.feeCharged.toString(),
    f.destinationAddress,
    f.destinationTag ?? '-',
    f.approvedBy,
    String(f.approvedAtMs),
    String(f.expiresAtMs),
    f.holdJournalId,
  ];
  // A delimiter inside a field would let one field bleed into the next.
  if (parts.some((p) => p.includes('|'))) throw new Error('Seal field contains a delimiter');
  return parts.join('|');
}

export function computeSeal(key: Buffer, fields: SealFields): string {
  if (key.length !== 32) throw new Error('The withdrawal seal key must be 32 bytes');
  return createHmac('sha256', key).update(canonical(fields)).digest('hex');
}

export function verifySeal(key: Buffer, fields: SealFields, seal: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(seal)) return false;
  const expected = Buffer.from(computeSeal(key, fields), 'hex');
  const given = Buffer.from(seal, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
