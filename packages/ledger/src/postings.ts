/**
 * Named postings for each financial event. Business modules call these
 * instead of assembling raw lines, so the accounting for an event is defined
 * once, reviewed once, and tested once.
 *
 * Reference formats (externalRef) are part of the idempotency contract and
 * must stay stable across releases.
 */
import { assertPositive } from '@actualpay/shared';
import type { Tx } from '@actualpay/database';
import { ensureAccount } from './accounts';
import { postJournal, type JournalLine, type PostResult } from './journal';

/**
 * A confirmed on-chain deposit to an organization.
 * Dr custody / Cr org_available.
 *
 * `depositRef` must identify the on-chain output uniquely, e.g.
 * `btc:<txid>:<vout>`, `eth:<txhash>:<logIndex>`, `xrp:<txhash>`.
 */
export async function postConfirmedDeposit(
  tx: Tx,
  params: {
    organizationId: string;
    assetId: string;
    amount: bigint;
    depositRef: string;
    metadata?: Record<string, unknown>;
  },
): Promise<PostResult> {
  assertPositive(params.amount, 'deposit amount');
  const custody = await ensureAccount(tx, {
    organizationId: null,
    assetId: params.assetId,
    type: 'custody',
  });
  const available = await ensureAccount(tx, {
    organizationId: params.organizationId,
    assetId: params.assetId,
    type: 'org_available',
  });
  return postJournal(tx, {
    externalRef: `deposit:${params.depositRef}`,
    kind: 'deposit_confirmed',
    organizationId: params.organizationId,
    lines: [
      { accountId: custody.id, direction: 'debit', amount: params.amount },
      { accountId: available.id, direction: 'credit', amount: params.amount },
    ],
    ...(params.metadata ? { metadata: params.metadata } : {}),
  });
}

/**
 * Reserve funds for a withdrawal before anything is signed.
 * Dr org_available / Cr org_withdrawal_hold for amount + fee charged.
 *
 * This is the step that makes concurrent withdrawals safe: it runs under a
 * row lock on org_available and fails with INSUFFICIENT_BALANCE rather than
 * letting two requests spend the same funds.
 */
export async function postWithdrawalHold(
  tx: Tx,
  params: {
    organizationId: string;
    assetId: string;
    withdrawalId: string;
    amount: bigint;
    feeCharged: bigint;
  },
): Promise<PostResult> {
  assertPositive(params.amount, 'withdrawal amount');
  if (params.feeCharged < 0n) throw new RangeError('feeCharged must not be negative');
  const total = params.amount + params.feeCharged;
  const available = await ensureAccount(tx, {
    organizationId: params.organizationId,
    assetId: params.assetId,
    type: 'org_available',
  });
  const hold = await ensureAccount(tx, {
    organizationId: params.organizationId,
    assetId: params.assetId,
    type: 'org_withdrawal_hold',
  });
  return postJournal(tx, {
    externalRef: `withdrawal:${params.withdrawalId}:hold`,
    kind: 'withdrawal_hold',
    organizationId: params.organizationId,
    lines: [
      { accountId: available.id, direction: 'debit', amount: total },
      { accountId: hold.id, direction: 'credit', amount: total },
    ],
  });
}

/**
 * Return held funds after a withdrawal is cancelled or fails *before* any
 * transaction could have reached the network.
 */
export async function postWithdrawalRelease(
  tx: Tx,
  params: { organizationId: string; assetId: string; withdrawalId: string; total: bigint },
): Promise<PostResult> {
  assertPositive(params.total, 'release amount');
  const available = await ensureAccount(tx, {
    organizationId: params.organizationId,
    assetId: params.assetId,
    type: 'org_available',
  });
  const hold = await ensureAccount(tx, {
    organizationId: params.organizationId,
    assetId: params.assetId,
    type: 'org_withdrawal_hold',
  });
  return postJournal(tx, {
    externalRef: `withdrawal:${params.withdrawalId}:release`,
    kind: 'withdrawal_release',
    organizationId: params.organizationId,
    lines: [
      { accountId: hold.id, direction: 'debit', amount: params.total },
      { accountId: available.id, direction: 'credit', amount: params.total },
    ],
  });
}

/**
 * Settle a withdrawal once its transaction is final on-chain.
 *
 *   Dr org_withdrawal_hold   amount + feeCharged      (asset)
 *   Cr custody               amount                   (asset)   coins left
 *   Cr platform_revenue      feeCharged               (asset)   if > 0
 *   Dr network_fees          networkFee               (fee asset)
 *   Cr custody               networkFee               (fee asset)
 *
 * The network fee is booked in the chain's fee asset (ETH for USDT-ERC20,
 * TRX for USDT-TRC20), so a single journal can balance in two assets.
 */
export async function postWithdrawalSettled(
  tx: Tx,
  params: {
    organizationId: string;
    assetId: string;
    withdrawalId: string;
    amount: bigint;
    feeCharged: bigint;
    networkFee: { assetId: string; amount: bigint };
  },
): Promise<PostResult> {
  assertPositive(params.amount, 'withdrawal amount');
  if (params.feeCharged < 0n || params.networkFee.amount < 0n)
    throw new RangeError('fees must not be negative');

  const hold = await ensureAccount(tx, {
    organizationId: params.organizationId,
    assetId: params.assetId,
    type: 'org_withdrawal_hold',
  });
  const custody = await ensureAccount(tx, {
    organizationId: null,
    assetId: params.assetId,
    type: 'custody',
  });
  const lines: JournalLine[] = [
    { accountId: hold.id, direction: 'debit', amount: params.amount + params.feeCharged },
    { accountId: custody.id, direction: 'credit', amount: params.amount },
  ];
  if (params.feeCharged > 0n) {
    const revenue = await ensureAccount(tx, {
      organizationId: null,
      assetId: params.assetId,
      type: 'platform_revenue',
    });
    lines.push({ accountId: revenue.id, direction: 'credit', amount: params.feeCharged });
  }
  if (params.networkFee.amount > 0n) {
    const feeExpense = await ensureAccount(tx, {
      organizationId: null,
      assetId: params.networkFee.assetId,
      type: 'network_fees',
    });
    const feeCustody = await ensureAccount(tx, {
      organizationId: null,
      assetId: params.networkFee.assetId,
      type: 'custody',
    });
    lines.push(
      { accountId: feeExpense.id, direction: 'debit', amount: params.networkFee.amount },
      { accountId: feeCustody.id, direction: 'credit', amount: params.networkFee.amount },
    );
  }
  return postJournal(tx, {
    externalRef: `withdrawal:${params.withdrawalId}:settled`,
    kind: 'withdrawal_settled',
    organizationId: params.organizationId,
    lines,
  });
}
