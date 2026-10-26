/**
 * Domain events (a transactional outbox).
 *
 * Written in the same transaction as the change they describe, so an event
 * exists if and only if the change committed. Webhook delivery (Phase 7) reads
 * this table; nothing else needs to be told.
 */
import { sql } from 'kysely';
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
  'webhook.test',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Record an event and queue a delivery for every active webhook endpoint of the
 * organization that subscribes to it, in the caller's transaction. With
 * `onlyEndpointId` (used by the test ping) only that endpoint is queued.
 */
export async function recordEvent(
  tx: Tx,
  event: {
    organizationId: string;
    type: EventType;
    subjectType: string;
    subjectId: string;
    payload: Record<string, unknown>;
  },
  options: { onlyEndpointId?: string } = {},
): Promise<string> {
  const inserted = await tx
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
    .returning('id')
    .executeTakeFirstOrThrow();
  await sql`
    INSERT INTO webhook_deliveries (endpoint_id, organization_id, event_id)
    SELECT id, organization_id, ${inserted.id}::bigint
    FROM webhook_endpoints
    WHERE organization_id = ${event.organizationId}::uuid
      AND status = 'active'
      AND (event_types @> ARRAY['*']::text[] OR event_types @> ARRAY[${event.type}]::text[])
      AND (${options.onlyEndpointId ?? null}::uuid IS NULL OR id = ${options.onlyEndpointId ?? null}::uuid)
    ON CONFLICT (endpoint_id, event_id) DO NOTHING
  `.execute(tx);
  return inserted.id;
}
