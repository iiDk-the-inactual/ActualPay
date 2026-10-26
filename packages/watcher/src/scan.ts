/**
 * The scan loop for one chain.
 *
 * Guarantees:
 *  - the cursor only moves forward after every transfer up to it has been
 *    handed to `recordObservation` (itself idempotent), so a crash or error
 *    can cause re-processing, never a gap;
 *  - nothing is finalised while the node is still syncing;
 *  - a transient failure (database or node hiccup) aborts the scan without
 *    advancing the cursor; a deterministic rejection of one transfer (it
 *    contradicts what we recorded) is raised as an issue and skipped, so one
 *    poisonous transfer cannot freeze a whole chain;
 *  - the cursor is created only when there is something to watch, at the
 *    current tip, so history is never imported and new invoices are never
 *    issued before a cursor exists (see packages/payments).
 */
import { isAppError, type ChainFamily, type NetworkMode } from '@actualpay/shared';
import type { IncomingTransfer, WatchOnlyAdapter } from '@actualpay/chains';
import type { Db } from '@actualpay/database';
import { recordObservation, type PaymentObservation } from '@actualpay/payments';
import type { Logger } from '@actualpay/shared';
import {
  getCursor,
  initialiseCursor,
  recordChainStatus,
  recordScanError,
  saveCursor,
} from './cursors';
import { autoResolveIssue, openIssue } from './issues';

/** Chains whose cursor is a block height and can lag far behind, so one run may take several rounds. */
const MULTI_ROUND: ReadonlySet<ChainFamily> = new Set(['ethereum']);
const MAX_ROUNDS = 50;

export type ScanOutcome =
  | { kind: 'skipped'; reason: 'unsynced' | 'nothing_to_watch' }
  | { kind: 'initialised' }
  | { kind: 'failed'; error: string }
  | { kind: 'scanned'; transfers: number; rejected: number; rounds: number };

export function toObservation(adapter: WatchOnlyAdapter, t: IncomingTransfer): PaymentObservation {
  return {
    chain: adapter.chain,
    network: adapter.network,
    ref: t.ref,
    assetId: t.assetId,
    txHash: t.txHash,
    toAddress: t.toAddress,
    destinationTag: t.destinationTag,
    amount: t.amount,
    blockHeight: t.blockHeight,
    blockHash: t.blockHash,
    confirmations: t.confirmations,
    final: t.final,
  };
}

async function hasConfirmedWallet(
  db: Db,
  chain: ChainFamily,
  network: NetworkMode,
): Promise<boolean> {
  const row = await db
    .selectFrom('wallets')
    .select('id')
    .where('chain', '=', chain)
    .where('network', '=', network)
    .where('verified_at', 'is not', null)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

export async function scanChain(params: {
  db: Db;
  logger: Logger;
  adapter: WatchOnlyAdapter;
  heartbeat?: () => Promise<void>;
  now?: Date;
}): Promise<ScanOutcome> {
  const { db, logger, adapter } = params;
  const { chain, network } = adapter;
  try {
    const status = await adapter.status();
    const cursorRow = await getCursor(db, chain, network);
    if (cursorRow) await recordChainStatus(db, chain, network, status);
    if (!status.synced) {
      logger.warn({ chain }, 'node is still syncing; not scanning');
      return { kind: 'skipped', reason: 'unsynced' };
    }

    if (!cursorRow) {
      if (!(await hasConfirmedWallet(db, chain, network)))
        return { kind: 'skipped', reason: 'nothing_to_watch' };
      const start = await adapter.scanIncoming(null);
      await initialiseCursor(db, chain, network, start.cursor);
      await recordChainStatus(db, chain, network, status);
      logger.info({ chain }, 'started watching chain at the current tip');
      return { kind: 'initialised' };
    }

    let cursor = cursorRow.cursor;
    let transfers = 0;
    let rejected = 0;
    let rounds = 0;
    while (rounds < (MULTI_ROUND.has(chain) ? MAX_ROUNDS : 1)) {
      rounds += 1;
      const result = await adapter.scanIncoming(cursor);
      for (const transfer of result.transfers) {
        try {
          await recordObservation(db, toObservation(adapter, transfer), params.now);
          transfers += 1;
        } catch (error) {
          if (!isAppError(error)) throw error; // transient: abort, keep the cursor
          rejected += 1;
          logger.error({ chain, ref: transfer.ref, err: error }, 'transfer rejected');
          await openIssue(db, {
            kind: 'observation_rejected',
            severity: 'critical',
            subjectType: 'transfer',
            subjectId: transfer.ref,
            summary: `A transfer on ${chain} contradicts what is recorded and was skipped.`,
            details: { code: error.code, message: error.message },
          });
        }
      }
      const advanced = result.cursor !== cursor;
      if (advanced) {
        await saveCursor(db, chain, network, result.cursor);
        cursor = result.cursor;
      }
      await params.heartbeat?.();
      if (!advanced) break;
    }
    await autoResolveIssue(db, 'watcher_error', 'chain', chain);
    return { kind: 'scanned', transfers, rejected, rounds };
  } catch (error) {
    logger.error({ chain, err: error }, 'chain scan failed');
    await recordScanError(db, chain, network, error).catch(() => undefined);
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
