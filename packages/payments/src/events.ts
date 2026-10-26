/**
 * Domain events (a transactional outbox).
 *
 * Written in the same transaction as the change they describe, so an event
 * exists if and only if the change committed. Webhook delivery (Phase 7) reads
 * this table; nothing else needs to be told.
 */
import type { Tx } from '@actualpay/database';

export const EVENT_TYPES = [
  'invoice.created',
  'invoice.processing',
  'invoice.partially_paid',
  'invoice.paid',
  'invoice.expired',
  'invoice.cancelled',
  'invoice.reopened',
  'payment.detected',
  'payment.confirmed',
  'payment.reversed',
  'withdrawal.requested',
  'withdrawal.approved',
  'withdrawal.broadcast',
  'withdrawal.confirmed',
  'withdrawal.failed',
  'withdrawal.cancelled',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export async function recordEvent(
  tx: Tx,
  event: {
    organizationId: string;
    type: EventType;
    subjectType: string;
    subjectId: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await tx
    .insertInto('domain_events')
    .values({
      organization_id: event.organizationId,
      type: event.type,
      subject_type: event.subjectType,
      subject_id: event.subjectId,
      payload: JSON.stringify(event.payload, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    })
    .execute();
}
