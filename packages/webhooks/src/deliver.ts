/**
 * Sending queued webhook deliveries.
 *
 * Semantics (documented for receivers): at-least-once, not ordered. A delivery
 * succeeds on any 2xx. Everything else (other statuses, redirects, timeouts,
 * DNS or TLS failures, forbidden destinations) is retried on an increasing
 * schedule for roughly two days, then marked failed (it can be re-sent by hand).
 * A 410 Gone disables the endpoint at once; many consecutive failures disable
 * it too, so a dead URL does not consume the queue for ever.
 */
import { sql } from 'kysely';
import { SecretBox } from '@actualpay/auth';
import type { Db, WebhookEndpointRow } from '@actualpay/database';
import { recordAudit } from '@actualpay/audit';
import type { Logger } from '@actualpay/shared';
import { activeSecrets } from './endpoints';
import { postJson, type Resolver } from './http';
import { signatureHeader } from './signing';
import type { UrlPolicy } from './ssrf';

/** Wait after the n-th failed attempt (n = 1…). The 11th failure is final. */
export const RETRY_DELAYS_SECONDS = [
  30, 120, 600, 1800, 3600, 7200, 14_400, 28_800, 43_200, 86_400,
];
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;
export const AUTO_DISABLE_AFTER = 50;
const CLAIM_SECONDS = 90;

export interface DeliverySummary {
  attempted: number;
  delivered: number;
  retried: number;
  failed: number;
}

interface Claimed {
  id: string;
  endpoint_id: string;
  organization_id: string;
  event_id: string;
  attempts: number;
}

export function buildEnvelope(event: {
  id: string;
  organization_id: string;
  type: string;
  subject_type: string;
  subject_id: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
}): string {
  return JSON.stringify({
    id: `evt_${event.id}`,
    type: event.type,
    createdAt: event.occurred_at.toISOString(),
    organizationId: event.organization_id,
    subject: { type: event.subject_type, id: event.subject_id },
    data: event.payload,
  });
}

export async function deliverDue(params: {
  db: Db;
  box: SecretBox;
  logger: Logger;
  policy: UrlPolicy;
  now?: Date;
  batchSize?: number;
  resolver?: Resolver;
}): Promise<DeliverySummary> {
  const { db, box, logger, policy } = params;
  const now = params.now ?? new Date();
  const summary: DeliverySummary = { attempted: 0, delivered: 0, retried: 0, failed: 0 };

  // Claim a batch: others skip claimed rows, and a crashed worker's claim lapses.
  const claimed = await sql<Claimed>`
    UPDATE webhook_deliveries d
       SET locked_until = ${new Date(now.getTime() + CLAIM_SECONDS * 1000)}
     WHERE d.id IN (
       SELECT d2.id
         FROM webhook_deliveries d2
         JOIN webhook_endpoints e ON e.id = d2.endpoint_id
        WHERE d2.status = 'pending'
          AND e.status = 'active'
          AND d2.next_attempt_at <= ${now}
          AND (d2.locked_until IS NULL OR d2.locked_until < ${now})
        ORDER BY d2.next_attempt_at
        LIMIT ${params.batchSize ?? 25}
        FOR UPDATE OF d2 SKIP LOCKED)
    RETURNING d.id, d.endpoint_id, d.organization_id, d.event_id::text AS event_id, d.attempts
  `.execute(db);

  for (const delivery of claimed.rows) {
    summary.attempted += 1;
    try {
      await attempt(delivery);
    } catch (error) {
      logger.error({ deliveryId: delivery.id, err: error }, 'webhook delivery crashed');
      await recordFailure(delivery, null, 'internal error');
    }
  }
  return summary;

  async function attempt(delivery: Claimed): Promise<void> {
    const endpoint = await db
      .selectFrom('webhook_endpoints')
      .selectAll()
      .where('id', '=', delivery.endpoint_id)
      .executeTakeFirstOrThrow();
    const event = await db
      .selectFrom('domain_events')
      .selectAll()
      .where('id', '=', delivery.event_id)
      .executeTakeFirstOrThrow();
    const body = buildEnvelope(event);
    const timestamp = Math.floor(now.getTime() / 1000);
    const secrets = activeSecrets(endpoint, box, now);
    const result = await postJson({
      url: endpoint.url,
      body,
      policy,
      ...(params.resolver ? { resolver: params.resolver } : {}),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ActualPay-Webhooks/1',
        'ActualPay-Event-Id': `evt_${event.id}`,
        'ActualPay-Event-Type': event.type,
        'ActualPay-Delivery-Id': delivery.id,
        'ActualPay-Delivery-Attempt': String(delivery.attempts + 1),
        'ActualPay-Signature': signatureHeader(secrets, timestamp, body),
      },
    });

    if (result.ok) {
      await db
        .updateTable('webhook_deliveries')
        .set({
          status: 'delivered',
          attempts: delivery.attempts + 1,
          delivered_at: now,
          last_attempt_at: now,
          last_status_code: result.statusCode,
          last_error: null,
          locked_until: null,
        })
        .where('id', '=', delivery.id)
        .execute();
      if (endpoint.consecutive_failures > 0) {
        await db
          .updateTable('webhook_endpoints')
          .set({ consecutive_failures: 0 })
          .where('id', '=', endpoint.id)
          .execute();
      }
      summary.delivered += 1;
      return;
    }
    if (result.statusCode === 410) await disable(endpoint, 'The endpoint answered 410 Gone.');
    await recordFailure(delivery, result.statusCode ?? null, result.error, endpoint);
  }

  async function recordFailure(
    delivery: Claimed,
    statusCode: number | null,
    error: string,
    endpoint?: WebhookEndpointRow,
  ): Promise<void> {
    const attempts = delivery.attempts + 1;
    const final = attempts >= MAX_ATTEMPTS;
    const delay = RETRY_DELAYS_SECONDS[attempts - 1];
    await db
      .updateTable('webhook_deliveries')
      .set({
        status: final ? 'failed' : 'pending',
        attempts,
        last_attempt_at: now,
        last_status_code: statusCode,
        last_error: error.slice(0, 500),
        locked_until: null,
        next_attempt_at: new Date(now.getTime() + (delay ?? 86_400) * 1000),
      })
      .where('id', '=', delivery.id)
      .execute();
    if (final) summary.failed += 1;
    else summary.retried += 1;

    const failures = await db
      .updateTable('webhook_endpoints')
      .set({ consecutive_failures: sql<number>`consecutive_failures + 1` })
      .where('id', '=', delivery.endpoint_id)
      .returning(['id', 'organization_id', 'consecutive_failures', 'status'])
      .executeTakeFirst();
    if (
      failures &&
      failures.status === 'active' &&
      failures.consecutive_failures >= AUTO_DISABLE_AFTER
    ) {
      await disable(
        endpoint ??
          (await db
            .selectFrom('webhook_endpoints')
            .selectAll()
            .where('id', '=', failures.id)
            .executeTakeFirstOrThrow()),
        `Disabled after ${AUTO_DISABLE_AFTER} consecutive failed deliveries.`,
      );
    }
  }

  async function disable(endpoint: WebhookEndpointRow, reason: string): Promise<void> {
    const changed = await db
      .updateTable('webhook_endpoints')
      .set({ status: 'disabled', disabled_reason: reason })
      .where('id', '=', endpoint.id)
      .where('status', '=', 'active')
      .returning('id')
      .executeTakeFirst();
    if (!changed) return;
    logger.warn({ endpointId: endpoint.id, reason }, 'webhook endpoint disabled');
    await recordAudit(db, {
      actor: { type: 'system' },
      action: 'webhook.endpoint_auto_disabled',
      organizationId: endpoint.organization_id,
      target: { type: 'webhook_endpoint', id: endpoint.id },
      metadata: { reason },
    });
  }
}
