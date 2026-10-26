/**
 * Turning what the chain shows into payments, ledger entries and invoice status.
 *
 * `recordObservation` is the single entry point watchers call for every
 * transfer they see, as often as they like. It is idempotent: the transfer's
 * chain reference (`ref`) identifies the payment, and the ledger reference
 * derived from it makes double-crediting impossible even if this code were
 * run twice at once.
 *
 *   seen, not final      → payment `pending`   (no ledger entry; invoice `processing`)
 *   final                → payment `confirmed` (ledger credit, same transaction)
 *   no longer on chain   → payment `reversed`  (ledger reversal if it had been credited)
 *   reappears            → back to `pending`   (a reorged transaction mined again)
 *
 * Money received in an asset other than the invoice's (say ETH sent to a USDT
 * invoice address) is still credited to the merchant, because the coins are
 * really ours now, but does not count toward the invoice.
 */
import { validateAddress } from '@actualpay/chains';
import {
  inTransaction,
  type Db,
  type InvoiceRow,
  type PaymentRow,
  type Tx,
} from '@actualpay/database';
import { postConfirmedDeposit, reverseJournal } from '@actualpay/ledger';
import {
  AppError,
  ASSETS,
  type AssetId,
  type ChainFamily,
  type NetworkMode,
} from '@actualpay/shared';
import { recordEvent } from './events';
import { moneyView, refreshInvoice } from './invoices';

export interface PaymentObservation {
  readonly chain: ChainFamily;
  readonly network: NetworkMode;
  readonly ref: string;
  readonly assetId: AssetId;
  readonly txHash: string;
  readonly toAddress: string;
  readonly destinationTag?: number | undefined;
  readonly amount: bigint;
  readonly blockHeight: bigint | null;
  readonly blockHash: string | null;
  readonly confirmations: bigint;
  /** The chain's finality rule is met: safe to credit. */
  readonly final: boolean;
}

export type ObservationOutcome =
  | {
      readonly kind: 'ignored';
      readonly reason: 'invalid_address' | 'unknown_address' | 'no_invoice';
    }
  | { readonly kind: 'recorded'; readonly payment: PaymentRow; readonly invoice: InvoiceRow };

/** Ledger reference suffix for the n-th confirmation of one payment. */
export function depositRefFor(ref: string, epoch: number): string {
  return epoch <= 1 ? ref : `${ref}:e${epoch}`;
}

function paymentPayload(payment: PaymentRow, invoice: InvoiceRow): Record<string, unknown> {
  return {
    paymentId: payment.id,
    invoiceId: invoice.id,
    externalId: invoice.external_id,
    ref: payment.ref,
    txHash: payment.tx_hash,
    status: payment.status,
    amount: moneyView(payment.asset_id, BigInt(payment.amount)),
    countsTowardInvoice: payment.counts_toward_invoice,
    confirmations: payment.confirmations,
  };
}

export async function recordObservationTx(
  tx: Tx,
  obs: PaymentObservation,
  now: Date = new Date(),
): Promise<ObservationOutcome> {
  if (ASSETS[obs.assetId].chain !== obs.chain)
    throw new AppError('INTERNAL', 'Observation asset does not belong to its chain.');
  if (obs.amount <= 0n) throw new AppError('INTERNAL', 'Observed amount must be positive.');

  const address = validateAddress(obs.chain, obs.network, obs.toAddress);
  if (!address) return { kind: 'ignored', reason: 'invalid_address' };

  let depositQuery = tx
    .selectFrom('deposit_addresses')
    .select('id')
    .where('chain', '=', obs.chain)
    .where('network', '=', obs.network)
    .where('address', '=', address);
  depositQuery =
    obs.destinationTag === undefined
      ? depositQuery.where('destination_tag', 'is', null)
      : depositQuery.where('destination_tag', '=', String(obs.destinationTag));
  const deposit = await depositQuery.executeTakeFirst();
  if (!deposit) return { kind: 'ignored', reason: 'unknown_address' };

  const invoiceRef = await tx
    .selectFrom('invoices')
    .select('id')
    .where('deposit_address_id', '=', deposit.id)
    .executeTakeFirst();
  if (!invoiceRef) return { kind: 'ignored', reason: 'no_invoice' };

  // Lock order is always invoice → payment → ledger accounts.
  const invoice = await tx
    .selectFrom('invoices')
    .selectAll()
    .where('id', '=', invoiceRef.id)
    .forUpdate()
    .executeTakeFirstOrThrow();

  let payment = await tx
    .selectFrom('payments')
    .selectAll()
    .where('ref', '=', obs.ref)
    .forUpdate()
    .executeTakeFirst();

  if (!payment) {
    payment = await tx
      .insertInto('payments')
      .values({
        organization_id: invoice.organization_id,
        invoice_id: invoice.id,
        deposit_address_id: deposit.id,
        ref: obs.ref,
        asset_id: obs.assetId,
        tx_hash: obs.txHash,
        amount: obs.amount,
        counts_toward_invoice: obs.assetId === invoice.asset_id,
        block_height: obs.blockHeight,
        block_hash: obs.blockHash,
        confirmations: obs.confirmations,
        detected_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordEvent(tx, {
      organizationId: invoice.organization_id,
      type: 'payment.detected',
      subjectType: 'payment',
      subjectId: payment.id,
      payload: paymentPayload(payment, invoice),
    });
  } else {
    if (
      BigInt(payment.amount) !== obs.amount ||
      payment.tx_hash !== obs.txHash ||
      payment.asset_id !== obs.assetId ||
      payment.deposit_address_id !== deposit.id
    ) {
      // The same chain reference must always describe the same transfer.
      throw new AppError('CONFLICT', 'An observed transfer does not match the recorded payment.', {
        details: { ref: obs.ref },
      });
    }
    if (payment.status === 'reversed') {
      payment = await tx
        .updateTable('payments')
        .set({
          status: 'pending',
          deposit_journal_id: null,
          reversal_journal_id: null,
          reversed_at: null,
          block_height: obs.blockHeight,
          block_hash: obs.blockHash,
          confirmations: obs.confirmations,
        })
        .where('id', '=', payment.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await recordEvent(tx, {
        organizationId: invoice.organization_id,
        type: 'payment.detected',
        subjectType: 'payment',
        subjectId: payment.id,
        payload: paymentPayload(payment, invoice),
      });
    } else {
      payment = await tx
        .updateTable('payments')
        .set({
          confirmations: obs.confirmations,
          ...(payment.status === 'pending'
            ? { block_height: obs.blockHeight, block_hash: obs.blockHash }
            : {}),
        })
        .where('id', '=', payment.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
  }

  if (obs.final && payment.status === 'pending') {
    const epoch = payment.epoch + 1;
    const posted = await postConfirmedDeposit(tx, {
      organizationId: invoice.organization_id,
      assetId: obs.assetId,
      amount: obs.amount,
      depositRef: depositRefFor(obs.ref, epoch),
      metadata: { paymentId: payment.id, invoiceId: invoice.id, txHash: obs.txHash },
    });
    payment = await tx
      .updateTable('payments')
      .set({
        status: 'confirmed',
        epoch,
        deposit_journal_id: posted.journalId,
        reversal_journal_id: null,
        confirmed_at: now,
      })
      .where('id', '=', payment.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordEvent(tx, {
      organizationId: invoice.organization_id,
      type: 'payment.confirmed',
      subjectType: 'payment',
      subjectId: payment.id,
      payload: paymentPayload(payment, invoice),
    });
  }

  const refreshed = await refreshInvoice(tx, invoice.id, now);
  return { kind: 'recorded', payment, invoice: refreshed };
}

export async function recordObservation(
  db: Db,
  obs: PaymentObservation,
  now?: Date,
): Promise<ObservationOutcome> {
  return inTransaction(db, (tx) => recordObservationTx(tx, obs, now));
}

/**
 * The chain no longer shows this transfer (reorged out, replaced or dropped).
 * Pending payments are simply withdrawn; confirmed ones get a ledger reversal.
 * A reversal that cannot be posted because the merchant already withdrew the
 * money throws INSUFFICIENT_BALANCE and rolls back: that is a real loss which
 * an operator must book explicitly (docs/ledger.md).
 */
export async function reversePaymentTx(
  tx: Tx,
  ref: string,
  now: Date = new Date(),
): Promise<PaymentRow | null> {
  const found = await tx
    .selectFrom('payments')
    .select('invoice_id')
    .where('ref', '=', ref)
    .executeTakeFirst();
  if (!found) return null;
  const invoice = await tx
    .selectFrom('invoices')
    .selectAll()
    .where('id', '=', found.invoice_id)
    .forUpdate()
    .executeTakeFirstOrThrow();
  let payment = await tx
    .selectFrom('payments')
    .selectAll()
    .where('ref', '=', ref)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (payment.status === 'reversed') return payment;

  let reversalJournalId: string | null = null;
  if (payment.status === 'confirmed') {
    if (!payment.deposit_journal_id)
      throw new AppError('INTERNAL', 'Confirmed payment has no ledger journal.');
    const reversal = await reverseJournal(tx, {
      journalId: payment.deposit_journal_id,
      externalRef: `reversal:${depositRefFor(ref, payment.epoch)}`,
      metadata: { paymentId: payment.id, invoiceId: invoice.id },
    });
    reversalJournalId = reversal.journalId;
  }
  payment = await tx
    .updateTable('payments')
    .set({ status: 'reversed', reversal_journal_id: reversalJournalId, reversed_at: now })
    .where('id', '=', payment.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await recordEvent(tx, {
    organizationId: invoice.organization_id,
    type: 'payment.reversed',
    subjectType: 'payment',
    subjectId: payment.id,
    payload: paymentPayload(payment, invoice),
  });
  await refreshInvoice(tx, invoice.id, now);
  return payment;
}

export async function reversePayment(db: Db, ref: string, now?: Date): Promise<PaymentRow | null> {
  return inTransaction(db, (tx) => reversePaymentTx(tx, ref, now));
}

export async function listPayments(
  db: Db,
  params: {
    organizationId: string;
    invoiceId?: string;
    limit: number;
    before?: { createdAt: string; id: string };
  },
): Promise<PaymentRow[]> {
  let query = db
    .selectFrom('payments')
    .selectAll()
    .where('organization_id', '=', params.organizationId);
  if (params.invoiceId) query = query.where('invoice_id', '=', params.invoiceId);
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
