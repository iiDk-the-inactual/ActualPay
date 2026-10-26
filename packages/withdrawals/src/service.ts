/**
 * The withdrawal lifecycle up to signing: request, approve, reject, cancel, expire.
 *
 *   request  → funds are HELD in the ledger at once (merchant balance → hold),
 *              so two requests can never spend the same money
 *   approve  → a different person, with two-factor authentication, seals it
 *   (the signer takes it from here, see packages/signer)
 *
 * The hold is released only while nothing has been signed. After signing, the
 * money may be on its way, so the hold is only ever settled or released by the
 * confirmation logic, which has proof either way.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  inTransaction,
  type Db,
  type Tx,
  type WithdrawalRow,
  type WithdrawalStatus,
} from '@actualpay/database';
import { postWithdrawalHold, postWithdrawalRelease } from '@actualpay/ledger';
import { recordAudit, type RequestMeta } from '@actualpay/audit';
import { moneyView, recordEvent, type EventType } from '@actualpay/payments';
import {
  AppError,
  applyBasisPoints,
  ASSETS,
  assertPositive,
  MAX_BASE_UNITS,
  type AssetId,
  type NetworkMode,
} from '@actualpay/shared';
import { isWithdrawableAsset, requireUsableDestination } from './destinations';
import { assertWithinPolicy } from './policy';
import { computeSeal, type SealFields } from './seal';
import { withdrawalsPaused } from './settings';

export interface WithdrawalConfig {
  readonly custodyMode: 'merchant' | 'platform';
  readonly feeBps: number;
  readonly enabledAssets: readonly AssetId[];
  readonly network: NetworkMode;
}

export type Requester = { readonly type: 'user' | 'api_key'; readonly id: string };

export function withdrawalPayload(w: WithdrawalRow): Record<string, unknown> {
  return {
    withdrawalId: w.id,
    status: w.status,
    clientRef: w.client_ref,
    amount: moneyView(w.asset_id, BigInt(w.amount)),
    feeCharged: moneyView(w.asset_id, BigInt(w.fee_charged)),
    destination: { address: w.destination_address, tag: w.destination_tag },
    txid: w.txid,
    confirmations: w.confirmations,
  };
}

const eventForStatus: Partial<Record<WithdrawalStatus, EventType>> = {
  approved: 'withdrawal.approved',
  rejected: 'withdrawal.cancelled',
  cancelled: 'withdrawal.cancelled',
  expired: 'withdrawal.cancelled',
  broadcast: 'withdrawal.broadcast',
  confirmed: 'withdrawal.confirmed',
  failed: 'withdrawal.failed',
};

export async function emitWithdrawalEvent(
  tx: Tx,
  w: WithdrawalRow,
  type?: EventType,
): Promise<void> {
  const eventType = type ?? eventForStatus[w.status];
  if (!eventType) return;
  await recordEvent(tx, {
    organizationId: w.organization_id,
    type: eventType,
    subjectType: 'withdrawal',
    subjectId: w.id,
    payload: withdrawalPayload(w),
  });
}

export function assertPlatformCustody(config: WithdrawalConfig): void {
  if (config.custodyMode !== 'platform')
    throw AppError.conflict(
      'Withdrawals are not available: this deployment does not hold funds for merchants (CUSTODY_MODE=merchant).',
    );
}

async function assertOrgActive(tx: Tx | Db, organizationId: string): Promise<void> {
  const org = await tx
    .selectFrom('organizations')
    .select('status')
    .where('id', '=', organizationId)
    .executeTakeFirst();
  if (!org) throw AppError.notFound('Organization');
  if (org.status !== 'active')
    throw new AppError('ORGANIZATION_SUSPENDED', 'The organization is suspended.');
}

export async function requestWithdrawal(
  db: Db,
  params: {
    organizationId: string;
    requester: Requester;
    assetId: AssetId;
    amount: bigint;
    destinationId: string;
    clientRef?: string;
    description?: string;
    config: WithdrawalConfig;
    now?: Date;
  },
  meta: RequestMeta,
): Promise<{ withdrawal: WithdrawalRow; created: boolean }> {
  const { config } = params;
  assertPlatformCustody(config);
  const asset = ASSETS[params.assetId];
  if (!isWithdrawableAsset(params.assetId))
    throw AppError.validation(`Withdrawals of ${String(params.assetId)} are not supported yet.`);
  if (!config.enabledAssets.includes(params.assetId))
    throw AppError.validation(`${params.assetId} is not enabled in this deployment.`);
  assertPositive(params.amount, 'Withdrawal amount');
  if (params.amount > MAX_BASE_UNITS) throw AppError.validation('Amount is too large.');
  const now = params.now ?? new Date();

  const existing = async (tx: Db | Tx) => {
    if (!params.clientRef) return null;
    return (
      (await tx
        .selectFrom('withdrawals')
        .selectAll()
        .where('organization_id', '=', params.organizationId)
        .where('client_ref', '=', params.clientRef)
        .executeTakeFirst()) ?? null
    );
  };
  const sameTerms = (w: WithdrawalRow) =>
    w.asset_id === params.assetId &&
    BigInt(w.amount) === params.amount &&
    w.destination_id === params.destinationId;

  return inTransaction(db, async (tx) => {
    // One request at a time per organization and asset: the limit checks below
    // read totals that a concurrent request would otherwise change under us.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`withdraw:${params.organizationId}:${params.assetId}`}, 0))`.execute(
      tx,
    );

    const prior = await existing(tx);
    if (prior) {
      if (!sameTerms(prior))
        throw AppError.conflict(
          'A withdrawal with this clientRef already exists with different terms.',
        );
      return { withdrawal: prior, created: false };
    }
    if ((await withdrawalsPaused(tx)).paused)
      throw AppError.conflict('Withdrawals are temporarily paused.');
    await assertOrgActive(tx, params.organizationId);

    const destination = await requireUsableDestination(tx, {
      organizationId: params.organizationId,
      destinationId: params.destinationId,
      chain: asset.chain,
      now,
    });
    await assertWithinPolicy(tx, {
      organizationId: params.organizationId,
      assetId: params.assetId,
      amount: params.amount,
      now,
    });

    const feeCharged = applyBasisPoints(params.amount, config.feeBps);
    const id = randomUUID();
    // Throws INSUFFICIENT_BALANCE if the merchant does not have amount + fee.
    const hold = await postWithdrawalHold(tx, {
      organizationId: params.organizationId,
      assetId: params.assetId,
      withdrawalId: id,
      amount: params.amount,
      feeCharged,
    });
    const withdrawal = await tx
      .insertInto('withdrawals')
      .values({
        id,
        organization_id: params.organizationId,
        asset_id: params.assetId,
        amount: params.amount,
        fee_charged: feeCharged,
        destination_id: destination.id,
        destination_address: destination.address,
        destination_tag: destination.destination_tag,
        client_ref: params.clientRef ?? null,
        description: params.description ?? null,
        requested_by_type: params.requester.type,
        requested_by_id: params.requester.id,
        hold_journal_id: hold.journalId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await emitWithdrawalEvent(tx, withdrawal, 'withdrawal.requested');
    await recordAudit(tx, {
      actor: params.requester,
      action: 'withdrawal.requested',
      organizationId: params.organizationId,
      target: { type: 'withdrawal', id },
      meta,
      metadata: {
        assetId: params.assetId,
        amount: params.amount.toString(),
        fee: feeCharged.toString(),
        destination: destination.address,
      },
    });
    return { withdrawal, created: true };
  });
}

async function lockWithdrawal(tx: Tx, organizationId: string, id: string): Promise<WithdrawalRow> {
  const row = await tx
    .selectFrom('withdrawals')
    .selectAll()
    .where('id', '=', id)
    .where('organization_id', '=', organizationId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw AppError.notFound('Withdrawal');
  return row;
}

export function sealFieldsOf(w: WithdrawalRow): SealFields {
  if (!w.approved_by || !w.approved_at || !w.approval_expires_at)
    throw new AppError('INTERNAL', 'Withdrawal is not approved.');
  return {
    withdrawalId: w.id,
    organizationId: w.organization_id,
    assetId: w.asset_id,
    amount: BigInt(w.amount),
    feeCharged: BigInt(w.fee_charged),
    destinationAddress: w.destination_address,
    destinationTag: w.destination_tag,
    approvedBy: w.approved_by,
    approvedAtMs: w.approved_at.getTime(),
    expiresAtMs: w.approval_expires_at.getTime(),
    holdJournalId: w.hold_journal_id,
  };
}

/**
 * Approve a pending withdrawal. The caller must already have checked that the
 * approver is an owner/admin whose session passed two-factor authentication.
 * Here: never the requester, still within policy, destination still usable,
 * platform not paused. The seal binds the approval to exactly these terms.
 */
export async function approveWithdrawal(
  db: Db,
  params: {
    organizationId: string;
    withdrawalId: string;
    approverUserId: string;
    sealKey: Buffer | undefined;
    approvalTtlMinutes: number;
    now?: Date;
  },
  meta: RequestMeta,
): Promise<WithdrawalRow> {
  const sealKey = params.sealKey;
  if (!sealKey) throw new AppError('INTERNAL', 'The withdrawal seal key is not configured.');
  const now = params.now ?? new Date();
  return inTransaction(db, async (tx) => {
    const w = await lockWithdrawal(tx, params.organizationId, params.withdrawalId);
    if (w.status !== 'pending_approval')
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        `A ${w.status.replace('_', ' ')} withdrawal cannot be approved.`,
      );
    if (w.requested_by_type === 'user' && w.requested_by_id === params.approverUserId)
      throw AppError.forbidden('You cannot approve a withdrawal you requested.');
    if ((await withdrawalsPaused(tx)).paused)
      throw AppError.conflict('Withdrawals are temporarily paused.');
    await assertOrgActive(tx, params.organizationId);
    const asset = ASSETS[w.asset_id as AssetId];
    await requireUsableDestination(tx, {
      organizationId: w.organization_id,
      destinationId: w.destination_id,
      chain: asset.chain,
      now,
    });
    await assertWithinPolicy(tx, {
      organizationId: w.organization_id,
      assetId: w.asset_id,
      amount: BigInt(w.amount),
      now,
      excludeWithdrawalId: w.id,
    });

    const expiresAt = new Date(now.getTime() + params.approvalTtlMinutes * 60_000);
    const seal = computeSeal(sealKey, {
      withdrawalId: w.id,
      organizationId: w.organization_id,
      assetId: w.asset_id,
      amount: BigInt(w.amount),
      feeCharged: BigInt(w.fee_charged),
      destinationAddress: w.destination_address,
      destinationTag: w.destination_tag,
      approvedBy: params.approverUserId,
      approvedAtMs: now.getTime(),
      expiresAtMs: expiresAt.getTime(),
      holdJournalId: w.hold_journal_id,
    });
    const approved = await tx
      .updateTable('withdrawals')
      .set({
        status: 'approved',
        approved_by: params.approverUserId,
        approved_at: now,
        approval_expires_at: expiresAt,
        approval_seal: seal,
      })
      .where('id', '=', w.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await emitWithdrawalEvent(tx, approved);
    await recordAudit(tx, {
      actor: { type: 'user', id: params.approverUserId },
      action: 'withdrawal.approved',
      organizationId: w.organization_id,
      target: { type: 'withdrawal', id: w.id },
      meta,
      metadata: {
        amount: w.amount,
        destination: w.destination_address,
        expiresAt: expiresAt.toISOString(),
      },
    });
    return approved;
  });
}

/** Return the held funds and close a withdrawal that was never signed. */
async function closeUnsigned(
  tx: Tx,
  w: WithdrawalRow,
  status: 'rejected' | 'cancelled' | 'expired',
  who: { userId?: string; reason?: string },
  now: Date,
): Promise<WithdrawalRow> {
  const release = await postWithdrawalRelease(tx, {
    organizationId: w.organization_id,
    assetId: w.asset_id,
    withdrawalId: w.id,
    total: BigInt(w.amount) + BigInt(w.fee_charged),
  });
  const closed = await tx
    .updateTable('withdrawals')
    .set({
      status,
      decided_at: now,
      ...(who.userId ? { decided_by: who.userId } : {}),
      ...(who.reason ? { decision_reason: who.reason.slice(0, 500) } : {}),
      release_journal_id: release.journalId,
    })
    .where('id', '=', w.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await emitWithdrawalEvent(tx, closed);
  return closed;
}

export async function rejectWithdrawal(
  db: Db,
  params: {
    organizationId: string;
    withdrawalId: string;
    userId: string;
    reason?: string;
    now?: Date;
  },
  meta: RequestMeta,
): Promise<WithdrawalRow> {
  return closeByUser(db, 'rejected', params, meta);
}

export async function cancelWithdrawal(
  db: Db,
  params: {
    organizationId: string;
    withdrawalId: string;
    userId: string;
    reason?: string;
    now?: Date;
  },
  meta: RequestMeta,
): Promise<WithdrawalRow> {
  return closeByUser(db, 'cancelled', params, meta);
}

async function closeByUser(
  db: Db,
  status: 'rejected' | 'cancelled',
  params: {
    organizationId: string;
    withdrawalId: string;
    userId: string;
    reason?: string;
    now?: Date;
  },
  meta: RequestMeta,
): Promise<WithdrawalRow> {
  const now = params.now ?? new Date();
  return inTransaction(db, async (tx) => {
    const w = await lockWithdrawal(tx, params.organizationId, params.withdrawalId);
    if (w.status === status) return w; // idempotent
    if (w.status !== 'pending_approval' && w.status !== 'approved') {
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        w.status === 'signed' || w.status === 'broadcast' || w.status === 'needs_review'
          ? 'This withdrawal has been signed and may already be on its way; it can no longer be cancelled.'
          : `A ${w.status} withdrawal cannot be ${status}.`,
      );
    }
    const closed = await closeUnsigned(
      tx,
      w,
      status,
      { userId: params.userId, ...(params.reason ? { reason: params.reason } : {}) },
      now,
    );
    await recordAudit(tx, {
      actor: { type: 'user', id: params.userId },
      action: `withdrawal.${status}`,
      organizationId: w.organization_id,
      target: { type: 'withdrawal', id: w.id },
      meta,
      metadata: { reason: params.reason ?? null },
    });
    return closed;
  });
}

/**
 * Expire approvals nobody signed in time and return their funds. Safe against
 * a signer signing at the same moment: both lock the row, and only one can
 * move it out of `approved`.
 */
export async function expireApprovals(
  db: Db,
  options: { now?: Date; limit?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  return inTransaction(db, async (tx) => {
    const due = await tx
      .selectFrom('withdrawals')
      .selectAll()
      .where('status', '=', 'approved')
      .where('approval_expires_at', '<=', now)
      .orderBy('approval_expires_at')
      .limit(options.limit ?? 100)
      .forUpdate()
      .skipLocked()
      .execute();
    for (const w of due) {
      await closeUnsigned(
        tx,
        w,
        'expired',
        { reason: 'The approval expired before it was signed.' },
        now,
      );
    }
    return due.length;
  });
}

export async function getWithdrawal(
  db: Db | Tx,
  organizationId: string,
  withdrawalId: string,
): Promise<WithdrawalRow> {
  const row = await db
    .selectFrom('withdrawals')
    .selectAll()
    .where('id', '=', withdrawalId)
    .where('organization_id', '=', organizationId)
    .executeTakeFirst();
  if (!row) throw AppError.notFound('Withdrawal');
  return row;
}

export async function listWithdrawals(
  db: Db,
  params: {
    organizationId: string;
    limit: number;
    status?: WithdrawalStatus;
    before?: { createdAt: string; id: string };
  },
): Promise<WithdrawalRow[]> {
  let query = db
    .selectFrom('withdrawals')
    .selectAll()
    .where('organization_id', '=', params.organizationId);
  if (params.status) query = query.where('status', '=', params.status);
  if (params.before) {
    const { createdAt, id } = params.before;
    query = query.where((eb) =>
      eb.or([
        eb('created_at', '<', new Date(createdAt)),
        eb.and([eb('created_at', '=', new Date(createdAt)), eb('id', '<', id)]),
      ]),
    );
  }
  return query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(params.limit).execute();
}
