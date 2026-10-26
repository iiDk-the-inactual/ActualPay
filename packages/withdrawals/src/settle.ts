/**
 * After signing: broadcast, follow to confirmation, settle the books.
 *
 * Principles:
 *  - The signed transaction and its txid are already stored, so broadcasting is
 *    idempotent and a lost response is reconciled by txid, never by guessing.
 *  - The ledger hold is settled only on proof the transaction is final, and
 *    released only on proof it failed after being mined (the EVM revert case).
 *    Anything uncertain goes to `needs_review` with an issue; the hold stays.
 *  - A signed transaction is a bearer instrument: once it exists it may be
 *    broadcast by anyone who has it. That is why an unbroadcastable one is never
 *    quietly "cancelled".
 */
import {
  inTransaction,
  openIssue,
  autoResolveIssue,
  type Db,
  type Tx,
  type WithdrawalRow,
} from '@actualpay/database';
import type { OutgoingChain } from '@actualpay/chains';
import {
  postWithdrawalFailedFee,
  postWithdrawalRelease,
  postWithdrawalSettled,
} from '@actualpay/ledger';
import { recordAudit } from '@actualpay/audit';
import { ASSETS, isAppError, type AssetId, type ChainFamily, type Logger } from '@actualpay/shared';
import { emitWithdrawalEvent } from './service';

/** Wait this long after broadcasting before treating a vanished transaction as lost. */
const LOST_AFTER_MS = 30 * 60_000;
/** A signed transaction still unbroadcast after this long is flagged. */
const UNBROADCAST_ISSUE_MS = 15 * 60_000;

export interface OutgoingSummary {
  broadcast: number;
  confirmed: number;
  failed: number;
  needsReview: number;
}

async function review(
  db: Db,
  w: WithdrawalRow,
  reason: string,
  kind: string,
  logger: Logger,
): Promise<void> {
  logger.error({ withdrawalId: w.id, reason }, 'withdrawal needs review');
  await inTransaction(db, async (tx) => {
    const current = await tx
      .selectFrom('withdrawals')
      .select('status')
      .where('id', '=', w.id)
      .forUpdate()
      .executeTakeFirst();
    if (current && (current.status === 'signed' || current.status === 'broadcast')) {
      await tx
        .updateTable('withdrawals')
        .set({ status: 'needs_review', last_error: reason.slice(0, 500) })
        .where('id', '=', w.id)
        .execute();
      await recordAudit(tx, {
        actor: { type: 'system' },
        action: 'withdrawal.needs_review',
        organizationId: w.organization_id,
        target: { type: 'withdrawal', id: w.id },
        metadata: { reason },
      });
    }
  });
  await openIssue(db, {
    kind,
    severity: 'critical',
    subjectType: 'withdrawal',
    subjectId: w.id,
    organizationId: w.organization_id,
    summary: `Withdrawal ${w.id} needs a human decision: ${reason}`.slice(0, 500),
    details: { txid: w.txid, reason },
  });
}

/** Send stored signed transactions to the network. Idempotent. */
export async function broadcastSigned(params: {
  db: Db;
  outgoing: ReadonlyMap<ChainFamily, OutgoingChain>;
  logger: Logger;
  now?: Date;
}): Promise<{ broadcast: number; needsReview: number }> {
  const { db, logger } = params;
  const now = params.now ?? new Date();
  const result = { broadcast: 0, needsReview: 0 };
  const signed = await db
    .selectFrom('withdrawals')
    .selectAll()
    .where('status', '=', 'signed')
    .orderBy('signed_at')
    .limit(20)
    .execute();
  for (const w of signed) {
    if (!w.signed_tx || !w.txid) continue;
    const chain = ASSETS[w.asset_id as AssetId].chain;
    const node = params.outgoing.get(chain);
    if (!node) continue;
    let outcome;
    try {
      outcome = await node.broadcast(w.signed_tx, w.txid);
    } catch (error) {
      logger.warn({ withdrawalId: w.id, err: error }, 'broadcast attempt failed; will retry');
      continue;
    }
    if (outcome.ok) {
      await inTransaction(db, async (tx) => {
        const updated = await tx
          .updateTable('withdrawals')
          .set({
            status: 'broadcast',
            broadcast_at: now,
            broadcast_attempts: w.broadcast_attempts + 1,
            last_error: null,
          })
          .where('id', '=', w.id)
          .where('status', '=', 'signed')
          .returningAll()
          .executeTakeFirst();
        if (!updated) return;
        await emitWithdrawalEvent(tx, updated);
        await recordAudit(tx, {
          actor: { type: 'system' },
          action: 'withdrawal.broadcast',
          organizationId: w.organization_id,
          target: { type: 'withdrawal', id: w.id },
          metadata: { txid: w.txid },
        });
      });
      await autoResolveIssue(db, 'withdrawal_unbroadcast', 'withdrawal', w.id);
      result.broadcast += 1;
      continue;
    }
    if (outcome.permanent) {
      await review(
        db,
        w,
        `the node rejected the transaction: ${outcome.error}`,
        'withdrawal_rejected_by_node',
        logger,
      );
      result.needsReview += 1;
      continue;
    }
    await db
      .updateTable('withdrawals')
      .set({
        broadcast_attempts: w.broadcast_attempts + 1,
        last_error: outcome.error.slice(0, 500),
      })
      .where('id', '=', w.id)
      .where('status', '=', 'signed')
      .execute();
    if (w.signed_at && now.getTime() - w.signed_at.getTime() > UNBROADCAST_ISSUE_MS) {
      await openIssue(db, {
        kind: 'withdrawal_unbroadcast',
        severity: 'warning',
        subjectType: 'withdrawal',
        subjectId: w.id,
        organizationId: w.organization_id,
        summary: 'A signed withdrawal could not be broadcast for a while.',
        details: { error: outcome.error },
      });
    }
  }
  return result;
}

/** Settle a final transaction: the hold becomes a payout, the books record the fee. */
export async function settleConfirmed(
  tx: Tx,
  w: WithdrawalRow,
  params: { networkFee: bigint; blockHeight: bigint; confirmations: bigint; now: Date },
): Promise<WithdrawalRow> {
  const asset = ASSETS[w.asset_id as AssetId];
  const settle = await postWithdrawalSettled(tx, {
    organizationId: w.organization_id,
    assetId: w.asset_id,
    withdrawalId: w.id,
    amount: BigInt(w.amount),
    feeCharged: BigInt(w.fee_charged),
    networkFee: { assetId: asset.feeAssetId, amount: params.networkFee },
  });
  const done = await tx
    .updateTable('withdrawals')
    .set({
      status: 'confirmed',
      confirmed_at: params.now,
      confirmations: params.confirmations,
      block_height: params.blockHeight,
      final_network_fee: params.networkFee,
      settle_journal_id: settle.journalId,
      last_error: null,
    })
    .where('id', '=', w.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await emitWithdrawalEvent(tx, done);
  await recordAudit(tx, {
    actor: { type: 'system' },
    action: 'withdrawal.confirmed',
    organizationId: w.organization_id,
    target: { type: 'withdrawal', id: w.id },
    metadata: { txid: w.txid, networkFee: params.networkFee.toString() },
  });
  return done;
}

/** A mined-but-reverted transaction: funds go back, the burnt fee is the platform's loss. */
export async function settleFailedOnChain(
  tx: Tx,
  w: WithdrawalRow,
  params: { networkFee: bigint; blockHeight: bigint; now: Date },
): Promise<WithdrawalRow> {
  const asset = ASSETS[w.asset_id as AssetId];
  const release = await postWithdrawalRelease(tx, {
    organizationId: w.organization_id,
    assetId: w.asset_id,
    withdrawalId: w.id,
    total: BigInt(w.amount) + BigInt(w.fee_charged),
  });
  await postWithdrawalFailedFee(tx, {
    organizationId: w.organization_id,
    withdrawalId: w.id,
    networkFee: { assetId: asset.feeAssetId, amount: params.networkFee },
  });
  const failed = await tx
    .updateTable('withdrawals')
    .set({
      status: 'failed',
      decided_at: params.now,
      decision_reason: 'The transaction was mined but reverted; the held funds were returned.',
      block_height: params.blockHeight,
      final_network_fee: params.networkFee,
      release_journal_id: release.journalId,
    })
    .where('id', '=', w.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await emitWithdrawalEvent(tx, failed);
  await recordAudit(tx, {
    actor: { type: 'system' },
    action: 'withdrawal.failed_on_chain',
    organizationId: w.organization_id,
    target: { type: 'withdrawal', id: w.id },
    metadata: { txid: w.txid, networkFee: params.networkFee.toString() },
  });
  return failed;
}

/** Follow broadcast withdrawals to finality. */
export async function trackBroadcasts(params: {
  db: Db;
  outgoing: ReadonlyMap<ChainFamily, OutgoingChain>;
  logger: Logger;
  now?: Date;
}): Promise<OutgoingSummary> {
  const { db, logger } = params;
  const now = params.now ?? new Date();
  const summary: OutgoingSummary = { broadcast: 0, confirmed: 0, failed: 0, needsReview: 0 };
  const open = await db
    .selectFrom('withdrawals')
    .selectAll()
    .where('status', '=', 'broadcast')
    .orderBy('broadcast_at')
    .limit(50)
    .execute();

  for (const w of open) {
    if (!w.txid || !w.signed_tx) continue;
    const chain = ASSETS[w.asset_id as AssetId].chain;
    const node = params.outgoing.get(chain);
    if (!node) continue;
    try {
      const status = await node.status(w.txid);

      if (status.state === 'mined') {
        if (!status.final) {
          await db
            .updateTable('withdrawals')
            .set({
              confirmations: status.confirmations,
              block_height: status.blockHeight,
              last_checked_at: now,
            })
            .where('id', '=', w.id)
            .where('status', '=', 'broadcast')
            .execute();
          continue;
        }
        const networkFee = status.networkFee ?? BigInt(w.planned_network_fee ?? 0);
        await inTransaction(db, async (tx) => {
          const locked = await tx
            .selectFrom('withdrawals')
            .selectAll()
            .where('id', '=', w.id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          if (locked.status !== 'broadcast') return;
          if (status.success) {
            await settleConfirmed(tx, locked, {
              networkFee,
              blockHeight: status.blockHeight,
              confirmations: status.confirmations,
              now,
            });
            summary.confirmed += 1;
          } else {
            await settleFailedOnChain(tx, locked, {
              networkFee,
              blockHeight: status.blockHeight,
              now,
            });
            summary.failed += 1;
          }
        });
        await autoResolveIssue(db, 'withdrawal_settlement_blocked', 'withdrawal', w.id);
        continue;
      }

      await db
        .updateTable('withdrawals')
        .set({ last_checked_at: now })
        .where('id', '=', w.id)
        .execute();
      if (status.state === 'pending') continue;

      if (status.state === 'conflicted') {
        await review(
          db,
          w,
          'a conflicting transaction spent the same coins',
          'withdrawal_conflicted',
          logger,
        );
        summary.needsReview += 1;
        continue;
      }
      // Unknown to the node: dropped or never propagated. Give it a grace period,
      // then try the (idempotent) broadcast again before calling it lost.
      if (w.broadcast_at && now.getTime() - w.broadcast_at.getTime() > LOST_AFTER_MS) {
        const again = await node.broadcast(w.signed_tx, w.txid);
        if (!again.ok) {
          await review(
            db,
            w,
            again.permanent
              ? `the transaction disappeared and cannot be re-broadcast: ${again.error}`
              : 'the transaction disappeared from the node',
            'withdrawal_lost',
            logger,
          );
          summary.needsReview += 1;
        }
      }
    } catch (error) {
      if (isAppError(error) && error.code === 'INSUFFICIENT_BALANCE') {
        // The books cannot absorb the network fee: custody needs funding. Not retried silently.
        await openIssue(db, {
          kind: 'withdrawal_settlement_blocked',
          severity: 'critical',
          subjectType: 'withdrawal',
          subjectId: w.id,
          organizationId: w.organization_id,
          summary:
            'A withdrawal is final on-chain but cannot be settled: platform funds in the books are too low to cover the network fee. Record the funding you added (docs/withdrawals.md).',
        });
      } else {
        logger.warn({ withdrawalId: w.id, err: error }, 'tracking failed; will retry');
      }
    }
  }
  return summary;
}
