/**
 * Re-verification of payments that are not yet settled for good.
 *
 * Pending payments are re-read every cycle; recently confirmed ones are
 * re-read for a while longer to catch a reorg deeper than the chain's
 * finality rule (rare, but it is exactly the case that loses money).
 *
 *   still on the chain → update confirmations (and confirm if now final)
 *   gone from the chain → reverse (ledger reversal if it had been credited)
 *
 * Circuit breaker: a node restored from an old snapshot, or pointed at the
 * wrong network, would report many real payments as "missing". If a single
 * cycle would reverse several payments on one chain, none are reversed and a
 * critical issue asks a human to look first. Genuine reorgs rarely drop more
 * than a couple of our payments at once.
 */
import { sql } from 'kysely';
import { ASSETS, isAppError, type ChainFamily, type AssetId } from '@actualpay/shared';
import type { WatchOnlyAdapter } from '@actualpay/chains';
import type { Db } from '@actualpay/database';
import { recordObservation, reversePayment } from '@actualpay/payments';
import type { Logger } from '@actualpay/shared';
import { autoResolveIssue, openIssue } from './issues';
import { toObservation } from './scan';

export const MASS_REVERSAL_THRESHOLD = 5;
export const RECHECK_CONFIRMED_HOURS = 6;

export interface RecheckSummary {
  checked: number;
  reversed: number;
  blocked: number;
  suspended: number;
}

export async function recheckPayments(params: {
  db: Db;
  logger: Logger;
  adapters: ReadonlyMap<ChainFamily, WatchOnlyAdapter>;
  now?: Date;
  batchSize?: number;
  massReversalThreshold?: number;
}): Promise<RecheckSummary> {
  const { db, logger, adapters } = params;
  const now = params.now ?? new Date();
  const batch = params.batchSize ?? 50;
  const threshold = params.massReversalThreshold ?? MASS_REVERSAL_THRESHOLD;
  const summary: RecheckSummary = { checked: 0, reversed: 0, blocked: 0, suspended: 0 };

  const candidates = await db
    .selectFrom('payments')
    .select(['id', 'ref', 'asset_id', 'status'])
    .where((eb) =>
      eb.or([
        eb('status', '=', 'pending'),
        eb.and([
          eb('status', '=', 'confirmed'),
          eb('confirmed_at', '>', new Date(now.getTime() - RECHECK_CONFIRMED_HOURS * 3_600_000)),
        ]),
      ]),
    )
    .orderBy(sql`last_checked_at NULLS FIRST`)
    .orderBy('created_at')
    .limit(batch)
    .execute();

  const byChain = new Map<ChainFamily, typeof candidates>();
  for (const c of candidates) {
    const chain = ASSETS[c.asset_id as AssetId].chain;
    byChain.set(chain, [...(byChain.get(chain) ?? []), c]);
  }

  for (const [chain, payments] of byChain) {
    const adapter = adapters.get(chain);
    if (!adapter) continue;
    let synced = false;
    try {
      synced = (await adapter.status()).synced;
    } catch (error) {
      logger.warn({ chain, err: error }, 'recheck: node unreachable, skipping chain');
      continue;
    }
    if (!synced) continue; // an unsynced node cannot say a transaction is missing

    const missing: string[] = [];
    const checkedIds: string[] = [];
    for (const payment of payments) {
      try {
        const result = await adapter.recheck(payment.ref);
        checkedIds.push(payment.id);
        summary.checked += 1;
        if (result.state === 'missing') {
          missing.push(payment.ref);
        } else {
          await recordObservation(db, toObservation(adapter, result.transfer), now);
        }
      } catch (error) {
        if (isAppError(error)) {
          await openIssue(db, {
            kind: 'observation_rejected',
            severity: 'critical',
            subjectType: 'transfer',
            subjectId: payment.ref,
            summary: `Re-checking a payment on ${chain} contradicted what is recorded.`,
            details: { code: error.code, message: error.message },
          });
        } else {
          logger.warn({ chain, ref: payment.ref, err: error }, 'recheck failed; will retry');
        }
      }
    }

    if (missing.length >= threshold) {
      summary.suspended += missing.length;
      logger.error({ chain, count: missing.length }, 'mass reversal suspected; not reversing');
      await openIssue(db, {
        kind: 'mass_reversal_suspected',
        severity: 'critical',
        subjectType: 'chain',
        subjectId: chain,
        summary: `${missing.length} payments on ${chain} look missing at once. No reversals were made; check the node before anything else.`,
        details: { refs: missing.slice(0, 20), count: missing.length },
      });
    } else {
      if (missing.length === 0)
        await autoResolveIssue(db, 'mass_reversal_suspected', 'chain', chain);
      for (const ref of missing) {
        try {
          const reversed = await reversePayment(db, ref, now);
          if (reversed) summary.reversed += 1;
          await autoResolveIssue(db, 'reversal_blocked', 'payment', ref);
        } catch (error) {
          if (isAppError(error) && error.code === 'INSUFFICIENT_BALANCE') {
            summary.blocked += 1;
            await openIssue(db, {
              kind: 'reversal_blocked',
              severity: 'critical',
              subjectType: 'payment',
              subjectId: ref,
              summary:
                'A confirmed deposit disappeared from the chain but the merchant already spent the money. The platform has a loss to book (docs/ledger.md).',
              details: { chain },
            });
          } else {
            logger.warn({ chain, ref, err: error }, 'reversal failed; will retry');
          }
        }
      }
    }

    if (checkedIds.length > 0) {
      await db
        .updateTable('payments')
        .set({ last_checked_at: now })
        .where('id', 'in', checkedIds)
        .execute();
    }
  }
  return summary;
}
