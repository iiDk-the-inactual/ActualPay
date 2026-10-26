/** Webhook endpoint management: create, update, rotate secrets, test, inspect deliveries. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { SecretBox } from '@actualpay/auth';
import {
  inTransaction,
  type Db,
  type WebhookDeliveryRow,
  type WebhookEndpointRow,
} from '@actualpay/database';
import { recordAudit, type AuditActor, type RequestMeta } from '@actualpay/audit';
import { EVENT_TYPES, recordEvent } from '@actualpay/payments';
import { AppError } from '@actualpay/shared';
import { generateWebhookSecret } from './signing';
import { validateWebhookUrl, type UrlPolicy } from './ssrf';

export const MAX_ENDPOINTS_PER_ORG = 20;
export const SECRET_GRACE_HOURS = 24;
export const ALL_EVENTS = '*';

export type WebhookActor = AuditActor & { type: 'user' | 'api_key' };

const secretContext = (endpointId: string) => `webhook:${endpointId}`;

export function validateEventTypes(types: readonly string[]): string[] {
  const unique = [...new Set(types)];
  if (unique.length === 0) throw AppError.validation('Choose at least one event type.');
  for (const type of unique) {
    if (type !== ALL_EVENTS && !(EVENT_TYPES as readonly string[]).includes(type))
      throw AppError.validation(`Unknown event type: ${type}`);
    if (type === 'webhook.test')
      throw AppError.validation('webhook.test is sent only by the test button.');
  }
  return unique.includes(ALL_EVENTS) ? [ALL_EVENTS] : unique.sort();
}

export async function createEndpoint(
  db: Db,
  params: {
    organizationId: string;
    actor: WebhookActor;
    url: string;
    description?: string;
    eventTypes: readonly string[];
    box: SecretBox;
    policy: UrlPolicy;
  },
  meta: RequestMeta,
): Promise<{ endpoint: WebhookEndpointRow; secret: string }> {
  const url = validateWebhookUrl(params.url, params.policy).toString();
  const eventTypes = validateEventTypes(params.eventTypes);
  const description = params.description?.trim() || null;
  if (description && description.length > 200)
    throw AppError.validation('The description must be at most 200 characters.');
  const id = randomUUID();
  const secret = generateWebhookSecret();
  return inTransaction(db, async (tx) => {
    const count = await tx
      .selectFrom('webhook_endpoints')
      .select(sql<string>`count(*)`.as('n'))
      .where('organization_id', '=', params.organizationId)
      .executeTakeFirstOrThrow();
    if (Number(count.n) >= MAX_ENDPOINTS_PER_ORG)
      throw AppError.validation(
        `An organization can have at most ${MAX_ENDPOINTS_PER_ORG} webhook endpoints.`,
      );
    const endpoint = await tx
      .insertInto('webhook_endpoints')
      .values({
        id,
        organization_id: params.organizationId,
        url,
        description,
        event_types: eventTypes,
        secret_ciphertext: params.box.seal(secret, secretContext(id)),
        created_by_type: params.actor.type,
        created_by_id: params.actor.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(tx, {
      actor: params.actor,
      action: 'webhook.endpoint_created',
      organizationId: params.organizationId,
      target: { type: 'webhook_endpoint', id },
      meta,
      metadata: { url, eventTypes },
    });
    return { endpoint, secret };
  });
}

export async function listEndpoints(db: Db, organizationId: string): Promise<WebhookEndpointRow[]> {
  return db
    .selectFrom('webhook_endpoints')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .orderBy('created_at', 'desc')
    .execute();
}

export async function getEndpoint(
  db: Db,
  organizationId: string,
  endpointId: string,
): Promise<WebhookEndpointRow> {
  const row = await db
    .selectFrom('webhook_endpoints')
    .selectAll()
    .where('id', '=', endpointId)
    .where('organization_id', '=', organizationId)
    .executeTakeFirst();
  if (!row) throw AppError.notFound('Webhook endpoint');
  return row;
}

export async function updateEndpoint(
  db: Db,
  params: {
    organizationId: string;
    endpointId: string;
    actor: WebhookActor;
    url?: string;
    description?: string | null;
    eventTypes?: readonly string[];
    status?: 'active' | 'disabled';
    policy: UrlPolicy;
  },
  meta: RequestMeta,
): Promise<WebhookEndpointRow> {
  const changes: Record<string, unknown> = {};
  if (params.url !== undefined)
    changes['url'] = validateWebhookUrl(params.url, params.policy).toString();
  if (params.eventTypes !== undefined)
    changes['event_types'] = validateEventTypes(params.eventTypes);
  if (params.description !== undefined) {
    const d = params.description?.trim() || null;
    if (d && d.length > 200)
      throw AppError.validation('The description must be at most 200 characters.');
    changes['description'] = d;
  }
  if (params.status !== undefined) {
    changes['status'] = params.status;
    if (params.status === 'active') {
      changes['disabled_reason'] = null;
      changes['consecutive_failures'] = 0;
    } else {
      changes['disabled_reason'] = 'Disabled by a user.';
    }
  }
  return inTransaction(db, async (tx) => {
    await getEndpoint(tx, params.organizationId, params.endpointId);
    const row = await tx
      .updateTable('webhook_endpoints')
      .set(changes as never)
      .where('id', '=', params.endpointId)
      .where('organization_id', '=', params.organizationId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(tx, {
      actor: params.actor,
      action: 'webhook.endpoint_updated',
      organizationId: params.organizationId,
      target: { type: 'webhook_endpoint', id: row.id },
      meta,
      metadata: {
        changed: Object.keys(changes),
        ...(params.status ? { status: params.status } : {}),
        ...(params.url ? { url: row.url } : {}),
      },
    });
    return row;
  });
}

/** New signing secret; the old one keeps signing alongside it for a grace period. */
export async function rotateSecret(
  db: Db,
  params: {
    organizationId: string;
    endpointId: string;
    actor: WebhookActor;
    box: SecretBox;
    now?: Date;
  },
  meta: RequestMeta,
): Promise<{ endpoint: WebhookEndpointRow; secret: string }> {
  const now = params.now ?? new Date();
  const secret = generateWebhookSecret();
  return inTransaction(db, async (tx) => {
    const current = await tx
      .selectFrom('webhook_endpoints')
      .selectAll()
      .where('id', '=', params.endpointId)
      .where('organization_id', '=', params.organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw AppError.notFound('Webhook endpoint');
    const endpoint = await tx
      .updateTable('webhook_endpoints')
      .set({
        secret_ciphertext: params.box.seal(secret, secretContext(current.id)),
        previous_secret_ciphertext: current.secret_ciphertext,
        previous_secret_expires_at: new Date(now.getTime() + SECRET_GRACE_HOURS * 3_600_000),
      })
      .where('id', '=', current.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(tx, {
      actor: params.actor,
      action: 'webhook.secret_rotated',
      organizationId: params.organizationId,
      target: { type: 'webhook_endpoint', id: current.id },
      meta,
    });
    return { endpoint, secret };
  });
}

/** The signing secrets currently valid for an endpoint (newest first). */
export function activeSecrets(endpoint: WebhookEndpointRow, box: SecretBox, now: Date): string[] {
  const secrets = [box.open(endpoint.secret_ciphertext, secretContext(endpoint.id))];
  if (
    endpoint.previous_secret_ciphertext &&
    endpoint.previous_secret_expires_at &&
    endpoint.previous_secret_expires_at.getTime() > now.getTime()
  ) {
    secrets.push(box.open(endpoint.previous_secret_ciphertext, secretContext(endpoint.id)));
  }
  return secrets;
}

/** Queue a `webhook.test` event for this endpoint only. */
export async function sendTest(
  db: Db,
  params: { organizationId: string; endpointId: string; actor: WebhookActor },
  meta: RequestMeta,
): Promise<{ eventId: string }> {
  return inTransaction(db, async (tx) => {
    const endpoint = await getEndpoint(tx, params.organizationId, params.endpointId);
    if (endpoint.status !== 'active') throw AppError.conflict('The endpoint is disabled.');
    const eventId = await recordEvent(
      tx,
      {
        organizationId: params.organizationId,
        type: 'webhook.test',
        subjectType: 'webhook_endpoint',
        subjectId: endpoint.id,
        payload: { message: 'This is a test event from ActualPay.' },
      },
      { onlyEndpointId: endpoint.id },
    );
    await recordAudit(tx, {
      actor: params.actor,
      action: 'webhook.test_sent',
      organizationId: params.organizationId,
      target: { type: 'webhook_endpoint', id: endpoint.id },
      meta,
    });
    return { eventId };
  });
}

export async function listDeliveries(
  db: Db,
  params: {
    organizationId: string;
    endpointId: string;
    limit: number;
    status?: WebhookDeliveryRow['status'];
    before?: { createdAt: string; id: string };
  },
): Promise<(WebhookDeliveryRow & { event_type: string })[]> {
  let query = db
    .selectFrom('webhook_deliveries')
    .innerJoin('domain_events', 'domain_events.id', 'webhook_deliveries.event_id')
    .selectAll('webhook_deliveries')
    .select('domain_events.type as event_type')
    .where('webhook_deliveries.organization_id', '=', params.organizationId)
    .where('webhook_deliveries.endpoint_id', '=', params.endpointId);
  if (params.status) query = query.where('webhook_deliveries.status', '=', params.status);
  if (params.before) {
    const { createdAt, id } = params.before;
    query = query.where((eb) =>
      eb.or([
        eb('webhook_deliveries.created_at', '<', new Date(createdAt)),
        eb.and([
          eb('webhook_deliveries.created_at', '=', new Date(createdAt)),
          eb('webhook_deliveries.id', '<', id),
        ]),
      ]),
    );
  }
  return query
    .orderBy('webhook_deliveries.created_at', 'desc')
    .orderBy('webhook_deliveries.id', 'desc')
    .limit(params.limit)
    .execute();
}

/** Send a delivery again (resets its attempts). The endpoint must be active. */
export async function redeliver(
  db: Db,
  params: { organizationId: string; deliveryId: string; actor: WebhookActor },
  meta: RequestMeta,
): Promise<void> {
  await inTransaction(db, async (tx) => {
    const delivery = await tx
      .selectFrom('webhook_deliveries')
      .innerJoin('webhook_endpoints', 'webhook_endpoints.id', 'webhook_deliveries.endpoint_id')
      .select([
        'webhook_deliveries.id',
        'webhook_deliveries.status',
        'webhook_endpoints.status as endpoint_status',
      ])
      .where('webhook_deliveries.id', '=', params.deliveryId)
      .where('webhook_deliveries.organization_id', '=', params.organizationId)
      .forUpdate('webhook_deliveries')
      .executeTakeFirst();
    if (!delivery) throw AppError.notFound('Webhook delivery');
    if (delivery.endpoint_status !== 'active') throw AppError.conflict('The endpoint is disabled.');
    if (delivery.status === 'pending') return; // already queued
    await tx
      .updateTable('webhook_deliveries')
      .set({
        status: 'pending',
        attempts: 0,
        next_attempt_at: new Date(),
        locked_until: null,
        delivered_at: null,
        last_error: null,
      })
      .where('id', '=', delivery.id)
      .execute();
    await recordAudit(tx, {
      actor: params.actor,
      action: 'webhook.delivery_requeued',
      organizationId: params.organizationId,
      target: { type: 'webhook_delivery', id: delivery.id },
      meta,
    });
  });
}
