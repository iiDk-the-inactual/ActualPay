/** Persistent scan positions. A cursor is saved only after everything up to it was processed. */
import { sql } from 'kysely';
import type { ChainCursorRow, Db } from '@actualpay/database';
import type { ChainFamily, NetworkMode } from '@actualpay/shared';

export async function getCursor(
  db: Db,
  chain: ChainFamily,
  network: NetworkMode,
): Promise<ChainCursorRow | undefined> {
  return db
    .selectFrom('chain_cursors')
    .selectAll()
    .where('chain', '=', chain)
    .where('network', '=', network)
    .executeTakeFirst();
}

/** Start watching at `cursor` (the chain's current tip). Does nothing if already initialised. */
export async function initialiseCursor(
  db: Db,
  chain: ChainFamily,
  network: NetworkMode,
  cursor: string,
): Promise<void> {
  await db
    .insertInto('chain_cursors')
    .values({ chain, network, cursor })
    .onConflict((oc) => oc.columns(['chain', 'network']).doNothing())
    .execute();
}

export async function saveCursor(
  db: Db,
  chain: ChainFamily,
  network: NetworkMode,
  cursor: string,
): Promise<void> {
  await db
    .updateTable('chain_cursors')
    .set({
      cursor,
      scanned_at: sql<Date>`now()`,
      last_error: null,
    })
    .where('chain', '=', chain)
    .where('network', '=', network)
    .execute();
}

export async function recordChainStatus(
  db: Db,
  chain: ChainFamily,
  network: NetworkMode,
  status: { tipHeight: bigint; finalHeight: bigint; synced: boolean },
): Promise<void> {
  await db
    .updateTable('chain_cursors')
    .set({
      tip_height: status.tipHeight,
      final_height: status.finalHeight,
      synced: status.synced,
      scanned_at: sql<Date>`now()`,
    })
    .where('chain', '=', chain)
    .where('network', '=', network)
    .execute();
}

export async function recordScanError(
  db: Db,
  chain: ChainFamily,
  network: NetworkMode,
  error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 900);
  await db
    .updateTable('chain_cursors')
    .set({ last_error: message, last_error_at: sql<Date>`now()` })
    .where('chain', '=', chain)
    .where('network', '=', network)
    .execute();
}
