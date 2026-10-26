/**
 * Platform-level controls: the hot-wallet registry and funding records.
 *
 * Registering a hot wallet is what authorises the signer to pay out from it, so
 * it is an audited administrator action (the signer refuses any wallet that is
 * not registered and active). Funding records tell the books about coins the
 * operator added to the platform's own holdings (for example ETH for gas).
 */
import { validateAddress } from '@actualpay/chains';
import { inTransaction, type Db, type HotWalletRow } from '@actualpay/database';
import { postPlatformFunding } from '@actualpay/ledger';
import { recordAudit, type RequestMeta } from '@actualpay/audit';
import {
  AppError,
  MAX_BASE_UNITS,
  type AssetId,
  type ChainFamily,
  type NetworkMode,
} from '@actualpay/shared';
import { withdrawableChains } from './destinations';

export async function registerHotWallet(
  db: Db,
  params: {
    chain: ChainFamily;
    network: NetworkMode;
    address: string;
    label: string;
    userId: string;
  },
  meta: RequestMeta,
): Promise<HotWalletRow> {
  if (!withdrawableChains().includes(params.chain))
    throw AppError.validation(`The signer does not support ${params.chain} yet.`);
  const address = validateAddress(params.chain, params.network, params.address.trim());
  if (!address) throw AppError.validation('That is not a valid address for this network.');
  const label = params.label.trim();
  if (label.length < 1 || label.length > 100)
    throw AppError.validation('The label must be 1–100 characters.');
  return inTransaction(db, async (tx) => {
    try {
      const row = await tx
        .insertInto('hot_wallets')
        .values({ chain: params.chain, network: params.network, address, label })
        .returningAll()
        .executeTakeFirstOrThrow();
      await recordAudit(tx, {
        actor: { type: 'user', id: params.userId },
        action: 'platform.hot_wallet_registered',
        target: { type: 'hot_wallet', id: row.id },
        meta,
        metadata: { chain: params.chain, network: params.network, address },
      });
      return row;
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw AppError.conflict(
          'A hot wallet is already registered for this chain, or this address was registered before. Retire the active one first.',
        );
      throw error;
    }
  });
}

export async function retireHotWallet(
  db: Db,
  params: { hotWalletId: string; userId: string },
  meta: RequestMeta,
): Promise<HotWalletRow> {
  return inTransaction(db, async (tx) => {
    const row = await tx
      .updateTable('hot_wallets')
      .set({ status: 'retired' })
      .where('id', '=', params.hotWalletId)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw AppError.notFound('Hot wallet');
    await recordAudit(tx, {
      actor: { type: 'user', id: params.userId },
      action: 'platform.hot_wallet_retired',
      target: { type: 'hot_wallet', id: row.id },
      meta,
      metadata: { address: row.address },
    });
    return row;
  });
}

export async function listHotWallets(db: Db): Promise<HotWalletRow[]> {
  return db.selectFrom('hot_wallets').selectAll().orderBy('created_at', 'desc').execute();
}

/** Record coins the operator added to the platform's own holdings. Idempotent per reference. */
export async function recordPlatformFunding(
  db: Db,
  params: { assetId: AssetId; amount: bigint; reference: string; note?: string; userId: string },
  meta: RequestMeta,
): Promise<{ journalId: string; created: boolean }> {
  if (params.amount <= 0n || params.amount > MAX_BASE_UNITS)
    throw AppError.validation('Invalid amount.');
  if (!/^[A-Za-z0-9_.:-]{3,100}$/.test(params.reference))
    throw AppError.validation('The reference must be 3–100 letters, digits or . _ : -');
  return inTransaction(db, async (tx) => {
    const posted = await postPlatformFunding(tx, {
      assetId: params.assetId,
      amount: params.amount,
      reference: params.reference,
      ...(params.note ? { note: params.note.slice(0, 500) } : {}),
    });
    if (posted.created) {
      await recordAudit(tx, {
        actor: { type: 'user', id: params.userId },
        action: 'platform.funding_recorded',
        target: { type: 'ledger_journal', id: posted.journalId },
        meta,
        metadata: {
          assetId: params.assetId,
          amount: params.amount.toString(),
          reference: params.reference,
        },
      });
    }
    return posted;
  });
}
