/**
 * Keeps the node's imported address range ahead of issued addresses (UTXO chains).
 *
 * Bitcoin/Litecoin Core only reports payments to addresses it was told about.
 * This task imports `[0, next_index + WATCH_AHEAD]` for every confirmed wallet
 * (archived ones too: customers pay late) and records how far the import
 * reaches in `wallets.watched_through`. Address allocation refuses to go past
 * that line, so an address is never issued before the node can see it.
 */
import { parseExtendedPublicKey, type BitcoinCoreAdapter } from '@actualpay/chains';
import type { Db } from '@actualpay/database';
import type { Logger } from '@actualpay/shared';

export const WATCH_AHEAD = 100;
const REFRESH_BELOW = 50;

export async function syncUtxoWatch(params: {
  db: Db;
  logger: Logger;
  adapter: BitcoinCoreAdapter;
}): Promise<{ imported: number }> {
  const { db, logger, adapter } = params;
  const wallets = await db
    .selectFrom('wallets')
    .select(['id', 'account_xpub', 'next_index', 'watched_through'])
    .where('chain', '=', adapter.chain)
    .where('network', '=', adapter.network)
    .where('verified_at', 'is not', null)
    .execute();
  const due = wallets.filter(
    (w) =>
      w.account_xpub !== null && Number(w.watched_through) - Number(w.next_index) < REFRESH_BELOW,
  );
  if (due.length === 0) return { imported: 0 };

  await adapter.ensureWatchWallet();
  let imported = 0;
  for (const wallet of due) {
    if (!wallet.account_xpub) continue;
    const rangeEnd = Number(wallet.next_index) + WATCH_AHEAD;
    await adapter.watchAccount(parseExtendedPublicKey(wallet.account_xpub), rangeEnd);
    await db
      .updateTable('wallets')
      .set({ watched_through: rangeEnd + 1 })
      .where('id', '=', wallet.id)
      .execute();
    imported += 1;
    logger.info({ walletId: wallet.id, through: rangeEnd }, 'extended watched address range');
  }
  return { imported };
}
