/**
 * Chart of accounts.
 *
 * Platform accounts (organization_id IS NULL), one per asset:
 *   custody           debit-normal   coins actually held on-chain by the platform
 *   network_fees      debit-normal   miner/validator fees paid (an expense)
 *   platform_revenue  credit-normal  processing fees charged to merchants
 *   suspense          debit-normal   reconciliation differences awaiting review;
 *                                    the only account allowed to go negative
 *
 * Organization accounts, one per (organization, asset):
 *   org_available        credit-normal  what the merchant can withdraw
 *   org_withdrawal_hold  credit-normal  funds reserved by in-flight withdrawals
 *
 * Invariant (checked by reconciliation): for every asset,
 *   custody = Σ org_available + Σ org_withdrawal_hold + platform_revenue
 *             − network_fees − suspense
 * i.e. everything the platform owes is backed by coins it holds.
 */
import { AppError } from '@actualpay/shared';
import type { LedgerAccountType, LedgerDirection, Tx } from '@actualpay/database';

export interface AccountPolicy {
  readonly normalSide: LedgerDirection;
  readonly scope: 'platform' | 'organization';
  readonly allowNegative: boolean;
}

export const ACCOUNT_POLICY: Readonly<Record<LedgerAccountType, AccountPolicy>> = {
  custody: { normalSide: 'debit', scope: 'platform', allowNegative: false },
  network_fees: { normalSide: 'debit', scope: 'platform', allowNegative: false },
  platform_revenue: { normalSide: 'credit', scope: 'platform', allowNegative: false },
  suspense: { normalSide: 'debit', scope: 'platform', allowNegative: true },
  org_available: { normalSide: 'credit', scope: 'organization', allowNegative: false },
  org_withdrawal_hold: { normalSide: 'credit', scope: 'organization', allowNegative: false },
};

export interface LedgerAccount {
  readonly id: string;
  readonly organizationId: string | null;
  readonly assetId: string;
  readonly type: LedgerAccountType;
  readonly normalSide: LedgerDirection;
  readonly allowNegative: boolean;
  readonly balance: bigint;
}

export interface AccountKey {
  readonly organizationId: string | null;
  readonly assetId: string;
  readonly type: LedgerAccountType;
}

/**
 * Return the account for (owner, asset, type), creating it if needed.
 * Concurrent callers converge on one row thanks to the unique constraint.
 */
export async function ensureAccount(tx: Tx, key: AccountKey): Promise<LedgerAccount> {
  const policy = ACCOUNT_POLICY[key.type];
  if ((policy.scope === 'organization') !== (key.organizationId !== null)) {
    throw new AppError('INTERNAL', 'Account scope does not match owner.', {
      details: { type: key.type },
    });
  }
  await tx
    .insertInto('ledger_accounts')
    .values({
      organization_id: key.organizationId,
      asset_id: key.assetId,
      type: key.type,
      normal_side: policy.normalSide,
      allow_negative: policy.allowNegative,
    })
    .onConflict((oc) => oc.columns(['organization_id', 'asset_id', 'type']).doNothing())
    .execute();

  let query = tx
    .selectFrom('ledger_accounts')
    .selectAll()
    .where('asset_id', '=', key.assetId)
    .where('type', '=', key.type);
  query =
    key.organizationId === null
      ? query.where('organization_id', 'is', null)
      : query.where('organization_id', '=', key.organizationId);
  const row = await query.executeTakeFirstOrThrow();
  return toAccount(row);
}

export function toAccount(row: {
  id: string;
  organization_id: string | null;
  asset_id: string;
  type: LedgerAccountType;
  normal_side: LedgerDirection;
  allow_negative: boolean;
  balance: string;
}): LedgerAccount {
  return {
    id: row.id,
    organizationId: row.organization_id,
    assetId: row.asset_id,
    type: row.type,
    normalSide: row.normal_side,
    allowNegative: row.allow_negative,
    balance: BigInt(row.balance),
  };
}

/** How an entry changes an account's balance, in the account's own terms. */
export function balanceDelta(
  normalSide: LedgerDirection,
  direction: LedgerDirection,
  amount: bigint,
): bigint {
  return direction === normalSide ? amount : -amount;
}
