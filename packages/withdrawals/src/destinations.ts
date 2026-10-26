/**
 * Withdrawal destinations (an allowlist).
 *
 * Money can only be sent to a destination the organization registered earlier,
 * and a new destination cannot be used until a cool-down has passed. This is the
 * control that limits what an attacker who takes over an account can do: they
 * can add their own address, but they cannot use it until the owners have had
 * the cool-down period to notice and revoke it.
 */
import { validateAddress } from '@actualpay/chains';
import {
  inTransaction,
  type Db,
  type Tx,
  type WithdrawalDestinationRow,
} from '@actualpay/database';
import { recordAudit, type RequestMeta } from '@actualpay/audit';
import {
  AppError,
  ASSETS,
  type AssetId,
  type ChainFamily,
  type NetworkMode,
} from '@actualpay/shared';

/** Assets the signer can pay out today. */
export const WITHDRAWABLE_ASSETS: readonly AssetId[] = ['btc', 'ltc', 'eth', 'usdt-erc20'];

export function isWithdrawableAsset(assetId: string): assetId is AssetId {
  return (WITHDRAWABLE_ASSETS as readonly string[]).includes(assetId);
}

export function withdrawableChains(): ChainFamily[] {
  return [...new Set(WITHDRAWABLE_ASSETS.map((id) => ASSETS[id].chain))];
}

export async function addDestination(
  db: Db,
  params: {
    organizationId: string;
    userId: string;
    chain: ChainFamily;
    address: string;
    label: string;
    network: NetworkMode;
    cooldownHours: number;
    now?: Date;
  },
  meta: RequestMeta,
): Promise<WithdrawalDestinationRow> {
  if (!withdrawableChains().includes(params.chain))
    throw AppError.validation(`Withdrawals on ${params.chain} are not supported yet.`);
  const address = validateAddress(params.chain, params.network, params.address.trim());
  if (!address)
    throw AppError.validation(`That is not a valid ${params.network} ${params.chain} address.`);
  const label = params.label.trim();
  if (label.length < 1 || label.length > 100)
    throw AppError.validation('The label must be 1–100 characters.');
  const now = params.now ?? new Date();
  return inTransaction(db, async (tx) => {
    try {
      const row = await tx
        .insertInto('withdrawal_destinations')
        .values({
          organization_id: params.organizationId,
          chain: params.chain,
          address,
          label,
          created_by: params.userId,
          created_at: now,
          active_at: new Date(now.getTime() + params.cooldownHours * 3_600_000),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await recordAudit(tx, {
        actor: { type: 'user', id: params.userId },
        action: 'withdrawal.destination_added',
        organizationId: params.organizationId,
        target: { type: 'withdrawal_destination', id: row.id },
        meta,
        metadata: { chain: params.chain, address, label, activeAt: row.active_at.toISOString() },
      });
      return row;
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw AppError.conflict('That destination is already registered.');
      throw error;
    }
  });
}

export async function revokeDestination(
  db: Db,
  params: { organizationId: string; destinationId: string; userId: string },
  meta: RequestMeta,
): Promise<WithdrawalDestinationRow> {
  return inTransaction(db, async (tx) => {
    const row = await tx
      .selectFrom('withdrawal_destinations')
      .selectAll()
      .where('id', '=', params.destinationId)
      .where('organization_id', '=', params.organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw AppError.notFound('Withdrawal destination');
    if (row.revoked_at) return row;
    const updated = await tx
      .updateTable('withdrawal_destinations')
      .set({ revoked_at: new Date(), revoked_by: params.userId })
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(tx, {
      actor: { type: 'user', id: params.userId },
      action: 'withdrawal.destination_revoked',
      organizationId: params.organizationId,
      target: { type: 'withdrawal_destination', id: row.id },
      meta,
      metadata: { address: row.address },
    });
    return updated;
  });
}

export async function listDestinations(
  db: Db,
  organizationId: string,
): Promise<WithdrawalDestinationRow[]> {
  return db
    .selectFrom('withdrawal_destinations')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .orderBy('created_at', 'desc')
    .limit(500)
    .execute();
}

/** A destination the organization may pay right now, or a precise reason it may not. */
export async function requireUsableDestination(
  tx: Db | Tx,
  params: { organizationId: string; destinationId: string; chain: ChainFamily; now: Date },
): Promise<WithdrawalDestinationRow> {
  const row = await tx
    .selectFrom('withdrawal_destinations')
    .selectAll()
    .where('id', '=', params.destinationId)
    .where('organization_id', '=', params.organizationId)
    .executeTakeFirst();
  if (!row) throw AppError.notFound('Withdrawal destination');
  if (row.revoked_at) throw AppError.validation('That destination has been revoked.');
  if (row.chain !== params.chain)
    throw AppError.validation('That destination is for a different network than the asset.');
  if (row.active_at.getTime() > params.now.getTime())
    throw AppError.validation(
      `That destination is still in its cool-down and can be used from ${row.active_at.toISOString()}.`,
    );
  return row;
}
