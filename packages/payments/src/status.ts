/**
 * The invoice state machine, as a pure function of facts.
 *
 * Status is never set by hand. Every change to a payment (detected, confirmed,
 * reversed), a cancellation or the passing of time recomputes it from the same
 * facts, so two code paths can never disagree about what an invoice is.
 *
 *   paid            confirmed ≥ amount due (always wins: money received is money received,
 *                   even after expiry or cancellation)
 *   cancelled       the merchant cancelled before any payment
 *   processing      a payment has been seen but is not final yet
 *   expired         time is up and nothing is in flight
 *   partially_paid  some confirmed money, less than due, still within time
 *   open            nothing received yet
 *
 * A confirmed payment can still be reversed by a deep reorg, so `paid` is not
 * terminal: the same function moves the invoice back when the facts change.
 */
import type { InvoiceStatus } from '@actualpay/database';

export interface InvoiceFacts {
  /** All in base units of the invoice asset. */
  readonly amountDue: bigint;
  readonly confirmed: bigint;
  readonly pending: bigint;
  readonly expiresAt: Date;
  readonly cancelledAt: Date | null;
  readonly now: Date;
}

export function deriveInvoiceStatus(facts: InvoiceFacts): InvoiceStatus {
  if (facts.confirmed >= facts.amountDue) return 'paid';
  if (facts.cancelledAt !== null) return 'cancelled';
  if (facts.pending > 0n) return 'processing';
  if (facts.now.getTime() >= facts.expiresAt.getTime()) return 'expired';
  if (facts.confirmed > 0n) return 'partially_paid';
  return 'open';
}

/** Statuses in which an invoice can still be expected to receive money. */
export const LIVE_STATUSES: readonly InvoiceStatus[] = ['open', 'processing', 'partially_paid'];
