/**
 * Withdrawal limit policies.
 *
 * Deny by default: an organization can withdraw an asset only if an enabled
 * policy exists for it. Policies are versions that are never edited. Tightening
 * (lower limits, or disabling) takes effect immediately; loosening takes effect
 * only after a delay, so someone who takes over an account cannot raise the
 * limit and drain it in one sitting.
 *
 * Which version applies: among versions already in effect, the most recently
 * CREATED. That makes a later tightening beat an earlier loosening even after
 * the loosening's delay has passed.
 */
import { sql } from 'kysely';
import { inTransaction, type Db, type Tx, type WithdrawalPolicyRow } from '@actualpay/database';
import { recordAudit, type RequestMeta } from '@actualpay/audit';
import { AppError, MAX_BASE_UNITS } from '@actualpay/shared';
import { isWithdrawableAsset } from './destinations';

export interface PolicyLimits {
  readonly enabled: boolean;
  readonly minAmount: bigint;
  readonly maxPerWithdrawal: bigint;
  readonly maxPerDay: bigint;
}

export function limitsOf(row: WithdrawalPolicyRow): PolicyLimits {
  return {
    enabled: row.enabled,
    minAmount: BigInt(row.min_amount),
    maxPerWithdrawal: BigInt(row.max_per_withdrawal),
    maxPerDay: BigInt(row.max_per_day),
  };
}

export async function getEffectivePolicy(
  db: Db | Tx,
  organizationId: string,
  assetId: string,
  now: Date,
): Promise<WithdrawalPolicyRow | null> {
  return (
    (await db
      .selectFrom('withdrawal_policy_versions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('asset_id', '=', assetId)
      .where('effective_at', '<=', now)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst()) ?? null
  );
}

/** True if `next` allows anything `previous` did not. */
export function isLoosening(previous: PolicyLimits | null, next: PolicyLimits): boolean {
  if (!next.enabled) return false;
  if (!previous || !previous.enabled) return true;
  return (
    next.maxPerWithdrawal > previous.maxPerWithdrawal ||
    next.maxPerDay > previous.maxPerDay ||
    next.minAmount < previous.minAmount
  );
}

export async function setPolicy(
  db: Db,
  params: {
    organizationId: string;
    assetId: string;
    userId: string;
    enabled: boolean;
    minAmount: bigint;
    maxPerWithdrawal: bigint;
    maxPerDay: bigint;
    increaseDelayHours: number;
    now?: Date;
  },
  meta: RequestMeta,
): Promise<WithdrawalPolicyRow> {
  if (!isWithdrawableAsset(params.assetId))
    throw AppError.validation('Withdrawals are not supported for that asset yet.');
  const limits: PolicyLimits = {
    enabled: params.enabled,
    minAmount: params.minAmount,
    maxPerWithdrawal: params.maxPerWithdrawal,
    maxPerDay: params.maxPerDay,
  };
  if (limits.enabled) {
    if (limits.minAmount < 0n || limits.maxPerWithdrawal <= 0n || limits.maxPerDay <= 0n)
      throw AppError.validation('Limits must be positive.');
    if (limits.minAmount > limits.maxPerWithdrawal)
      throw AppError.validation('The minimum cannot exceed the per-withdrawal maximum.');
    if (limits.maxPerWithdrawal > limits.maxPerDay)
      throw AppError.validation('The per-withdrawal maximum cannot exceed the daily maximum.');
  }
  for (const v of [limits.minAmount, limits.maxPerWithdrawal, limits.maxPerDay])
    if (v > MAX_BASE_UNITS) throw AppError.validation('A limit is too large.');
  const now = params.now ?? new Date();

  return inTransaction(db, async (tx) => {
    // Serialise policy changes per organization and asset.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`policy:${params.organizationId}:${params.assetId}`}, 0))`.execute(
      tx,
    );
    // Compare with the newest version, pending or not, so loosening can't be
    // staged in two small steps that each look harmless.
    const newest = await tx
      .selectFrom('withdrawal_policy_versions')
      .selectAll()
      .where('organization_id', '=', params.organizationId)
      .where('asset_id', '=', params.assetId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    const loosening = isLoosening(newest ? limitsOf(newest) : null, limits);
    const effectiveAt = loosening
      ? new Date(now.getTime() + params.increaseDelayHours * 3_600_000)
      : now;
    const row = await tx
      .insertInto('withdrawal_policy_versions')
      .values({
        organization_id: params.organizationId,
        asset_id: params.assetId,
        enabled: limits.enabled,
        min_amount: limits.minAmount,
        max_per_withdrawal: limits.maxPerWithdrawal,
        max_per_day: limits.maxPerDay,
        effective_at: effectiveAt,
        created_by: params.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(tx, {
      actor: { type: 'user', id: params.userId },
      action: 'withdrawal.policy_changed',
      organizationId: params.organizationId,
      target: { type: 'withdrawal_policy', id: row.id },
      meta,
      metadata: {
        assetId: params.assetId,
        enabled: limits.enabled,
        minAmount: limits.minAmount.toString(),
        maxPerWithdrawal: limits.maxPerWithdrawal.toString(),
        maxPerDay: limits.maxPerDay.toString(),
        loosening,
        effectiveAt: effectiveAt.toISOString(),
      },
    });
    return row;
  });
}

export async function listPolicies(db: Db, organizationId: string) {
  return db
    .selectFrom('withdrawal_policy_versions')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .orderBy('created_at', 'desc')
    .limit(200)
    .execute();
}

/** Total of an organization's non-terminal-failure withdrawals of an asset in the last 24 hours. */
export async function dailyTotal(
  db: Db | Tx,
  organizationId: string,
  assetId: string,
  now: Date,
): Promise<bigint> {
  const row = await db
    .selectFrom('withdrawals')
    .select(sql<string>`COALESCE(SUM(amount), 0)`.as('total'))
    .where('organization_id', '=', organizationId)
    .where('asset_id', '=', assetId)
    .where('created_at', '>', new Date(now.getTime() - 24 * 3_600_000))
    .where('status', 'not in', ['rejected', 'cancelled', 'expired', 'failed'])
    .executeTakeFirstOrThrow();
  return BigInt(row.total);
}

/** Throws unless the policy in force allows this amount right now. */
export async function assertWithinPolicy(
  db: Db | Tx,
  params: {
    organizationId: string;
    assetId: string;
    amount: bigint;
    now: Date;
    excludeWithdrawalId?: string;
  },
): Promise<void> {
  const row = await getEffectivePolicy(db, params.organizationId, params.assetId, params.now);
  if (!row || !row.enabled)
    throw AppError.validation('Withdrawals of this asset are not enabled for this organization.');
  const limits = limitsOf(row);
  if (params.amount < limits.minAmount)
    throw AppError.validation('The amount is below the minimum withdrawal.');
  if (params.amount > limits.maxPerWithdrawal)
    throw AppError.validation('The amount exceeds the per-withdrawal limit.');
  let used = await dailyTotal(db, params.organizationId, params.assetId, params.now);
  if (params.excludeWithdrawalId) {
    const own = await db
      .selectFrom('withdrawals')
      .select('amount')
      .where('id', '=', params.excludeWithdrawalId)
      .executeTakeFirst();
    if (own) used -= BigInt(own.amount);
  }
  if (used + params.amount > limits.maxPerDay)
    throw AppError.validation('The amount would exceed the daily withdrawal limit.');
}
