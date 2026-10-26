/** Shared fixtures for the withdrawal tests. */
import { randomBytes } from 'node:crypto';
import { inTransaction, type Db } from '@actualpay/database';
import { postConfirmedDeposit, postPlatformFunding } from '@actualpay/ledger';
import { addDestination, setPolicy } from '@actualpay/withdrawals';
import type { AssetId } from '@actualpay/shared';
import { createOrganization } from './helpers';

export const meta = { requestId: 'test' };
export const SEAL_KEY = Buffer.alloc(32, 5);

export async function createUser(db: Db, label: string): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({
      email: `${label}-${randomBytes(4).toString('hex')}@example.test`,
      password_hash: '$argon2id$v=19$m=19456,t=2,p=1$dGVzdA$dGVzdA',
      display_name: label,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function addMember(
  db: Db,
  organizationId: string,
  userId: string,
  role: 'owner' | 'admin' | 'finance' | 'developer' | 'viewer',
  mfa = false,
): Promise<void> {
  await db
    .insertInto('organization_members')
    .values({ organization_id: organizationId, user_id: userId, role })
    .execute();
  if (mfa) {
    await db
      .insertInto('totp_credentials')
      .values({ user_id: userId, secret_ciphertext: 'v1.test.test.test', confirmed_at: new Date() })
      .onConflict((oc) => oc.column('user_id').doNothing())
      .execute();
  }
}

export interface Fixture {
  orgId: string;
  requesterId: string;
  approverId: string;
  adminId: string;
}

/** An organization with a requester (finance), an approver (owner, MFA) and a platform admin. */
export async function orgWithPeople(db: Db): Promise<Fixture> {
  const orgId = await createOrganization(db);
  const approverId = await createUser(db, 'approver');
  const requesterId = await createUser(db, 'requester');
  const adminId = await createUser(db, 'admin');
  await addMember(db, orgId, approverId, 'owner', true);
  await addMember(db, orgId, requesterId, 'finance');
  await addMember(db, orgId, adminId, 'admin', true);
  return { orgId, requesterId, approverId, adminId };
}

export async function seedBalance(
  db: Db,
  orgId: string,
  assetId: AssetId,
  amount: bigint,
): Promise<void> {
  await inTransaction(db, (tx) =>
    postConfirmedDeposit(tx, {
      organizationId: orgId,
      assetId,
      amount,
      depositRef: `seed:${randomBytes(6).toString('hex')}`,
    }),
  );
}

/** Coins the operator added for fees; without them custody cannot absorb a network fee. */
export async function seedPlatformFunds(db: Db, assetId: AssetId, amount: bigint): Promise<void> {
  await inTransaction(db, (tx) =>
    postPlatformFunding(tx, {
      assetId,
      amount,
      reference: `fund-${randomBytes(6).toString('hex')}`,
    }),
  );
}

export async function enablePolicy(
  db: Db,
  f: Fixture,
  assetId: AssetId,
  limits: { min?: bigint; perWithdrawal: bigint; perDay: bigint },
): Promise<void> {
  await setPolicy(
    db,
    {
      organizationId: f.orgId,
      assetId,
      userId: f.approverId,
      enabled: true,
      minAmount: limits.min ?? 1n,
      maxPerWithdrawal: limits.perWithdrawal,
      maxPerDay: limits.perDay,
      increaseDelayHours: 0,
    },
    meta,
  );
}

export async function usableDestination(
  db: Db,
  f: Fixture,
  chain: 'ethereum' | 'bitcoin' | 'litecoin',
  address: string,
  label = 'cold storage',
) {
  return addDestination(
    db,
    {
      organizationId: f.orgId,
      userId: f.approverId,
      chain,
      address,
      label,
      network: 'testnet',
      cooldownHours: 0,
      now: new Date(Date.now() - 1000),
    },
    meta,
  );
}
