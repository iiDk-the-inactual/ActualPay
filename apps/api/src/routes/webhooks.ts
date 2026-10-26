/**
 * Webhook endpoint management and delivery inspection.
 *
 * The signing secret is shown once, at creation and at rotation. Endpoint URLs
 * are validated against SSRF rules (https only, no private destinations) here
 * and again on every delivery.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SecretBox, type OrgAccess } from '@actualpay/auth';
import {
  AppError,
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  encodeCursor,
  MAX_PAGE_SIZE,
} from '@actualpay/shared';
import { EVENT_TYPES } from '@actualpay/payments';
import type { WebhookDeliveryRow, WebhookEndpointRow } from '@actualpay/database';
import {
  createEndpoint,
  getEndpoint,
  listDeliveries,
  listEndpoints,
  redeliver,
  rotateSecret,
  sendTest,
  updateEndpoint,
  type WebhookActor,
} from '@actualpay/webhooks';
import type { ApiContext } from '../http/context';
import { auditActor, type Principal } from '../http/principal';
import { defineRoute } from '../http/route';
import { isoDate, nullableIsoDate, orgParams, uuid } from './schemas';

function orgIdOf(access: OrgAccess | null): string {
  if (!access) throw AppError.notFound('Organization');
  return access.organizationId;
}

function actorOf(principal: Principal | null): WebhookActor {
  if (!principal) throw AppError.unauthenticated();
  const actor = auditActor(principal);
  if (actor.type === 'system') throw AppError.unauthenticated();
  return actor;
}

const endpointParams = z.object({ orgId: uuid, endpointId: uuid });
const deliveryParams = z.object({ orgId: uuid, deliveryId: uuid });
const eventTypeInput = z.string().max(60);

const endpointSchema = z.object({
  id: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  eventTypes: z.array(z.string()),
  status: z.enum(['active', 'disabled']),
  disabledReason: z.string().nullable(),
  consecutiveFailures: z.number(),
  rotationGraceEndsAt: nullableIsoDate,
  createdAt: isoDate,
});

const deliverySchema = z.object({
  id: z.string(),
  eventId: z.string(),
  eventType: z.string(),
  status: z.enum(['pending', 'delivered', 'failed']),
  attempts: z.number(),
  nextAttemptAt: isoDate,
  lastAttemptAt: nullableIsoDate,
  lastStatusCode: z.number().nullable(),
  lastError: z.string().nullable(),
  deliveredAt: nullableIsoDate,
  createdAt: isoDate,
});

const toEndpoint = (e: WebhookEndpointRow) => ({
  id: e.id,
  url: e.url,
  description: e.description,
  eventTypes: e.event_types,
  status: e.status,
  disabledReason: e.disabled_reason,
  consecutiveFailures: e.consecutive_failures,
  rotationGraceEndsAt:
    e.previous_secret_expires_at && e.previous_secret_expires_at.getTime() > Date.now()
      ? e.previous_secret_expires_at
      : null,
  createdAt: e.created_at,
});

const toDelivery = (d: WebhookDeliveryRow & { event_type: string }) => ({
  id: d.id,
  eventId: String(d.event_id),
  eventType: d.event_type,
  status: d.status,
  attempts: d.attempts,
  nextAttemptAt: d.next_attempt_at,
  lastAttemptAt: d.last_attempt_at,
  lastStatusCode: d.last_status_code,
  lastError: d.last_error,
  deliveredAt: d.delivered_at,
  createdAt: d.created_at,
});

export function registerWebhookRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const tags = ['webhooks'];
  const box = new SecretBox(ctx.config.secrets.encryptionKey, 'webhooks');
  const policy = ctx.config.webhooks;
  const shownOnce = 'Store this signing secret now. It cannot be retrieved again.';

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/organizations/:orgId/webhooks',
    summary: 'Create a webhook endpoint (signing secret shown once)',
    tags,
    auth: 'session_or_api_key',
    org: 'webhook:manage',
    idempotency: 'optional',
    params: orgParams,
    body: z
      .object({
        url: z.string().trim().min(10).max(2000),
        description: z.string().trim().max(200).optional(),
        eventTypes: z.array(eventTypeInput).min(1).max(40).default(['*']),
      })
      .strict(),
    response: z.object({ endpoint: endpointSchema, secret: z.string(), warning: z.string() }),
    successStatus: 201,
    handler: async ({ access, principal, body, meta }) => {
      const { endpoint, secret } = await createEndpoint(
        ctx.db,
        {
          organizationId: orgIdOf(access),
          actor: actorOf(principal),
          url: body.url,
          ...(body.description ? { description: body.description } : {}),
          eventTypes: body.eventTypes,
          box,
          policy,
        },
        meta,
      );
      return { endpoint: toEndpoint(endpoint), secret, warning: shownOnce };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/webhooks',
    summary: 'List webhook endpoints',
    tags,
    auth: 'session_or_api_key',
    org: 'webhook:read',
    params: orgParams,
    response: z.object({ data: z.array(endpointSchema), eventTypes: z.array(z.string()) }),
    handler: async ({ access }) => ({
      data: (await listEndpoints(ctx.db, orgIdOf(access))).map(toEndpoint),
      eventTypes: EVENT_TYPES.filter((t) => t !== 'webhook.test'),
    }),
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/webhooks/:endpointId',
    summary: 'Get a webhook endpoint',
    tags,
    auth: 'session_or_api_key',
    org: 'webhook:read',
    params: endpointParams,
    response: endpointSchema,
    handler: async ({ access, params }) =>
      toEndpoint(await getEndpoint(ctx.db, orgIdOf(access), params.endpointId)),
  });

  defineRoute(app, ctx, {
    method: 'PATCH',
    url: '/v1/organizations/:orgId/webhooks/:endpointId',
    summary: 'Change a webhook endpoint (URL, events, description, enable/disable)',
    tags,
    auth: 'session_or_api_key',
    org: 'webhook:manage',
    params: endpointParams,
    body: z
      .object({
        url: z.string().trim().min(10).max(2000).optional(),
        description: z.string().trim().max(200).nullable().optional(),
        eventTypes: z.array(eventTypeInput).min(1).max(40).optional(),
        status: z.enum(['active', 'disabled']).optional(),
      })
      .strict(),
    response: endpointSchema,
    handler: async ({ access, principal, params, body, meta }) =>
      toEndpoint(
        await updateEndpoint(
          ctx.db,
          {
            organizationId: orgIdOf(access),
            endpointId: params.endpointId,
            actor: actorOf(principal),
            ...(body.url !== undefined ? { url: body.url } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.eventTypes !== undefined ? { eventTypes: body.eventTypes } : {}),
            ...(body.status !== undefined ? { status: body.status } : {}),
            policy,
          },
          meta,
        ),
      ),
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/organizations/:orgId/webhooks/:endpointId/rotate-secret',
    summary: 'Issue a new signing secret (the old one also signs for 24 hours)',
    tags,
    auth: 'session_or_api_key',
    org: 'webhook:manage',
    idempotency: 'optional',
    params: endpointParams,
    response: z.object({ endpoint: endpointSchema, secret: z.string(), warning: z.string() }),
    successStatus: 200,
    handler: async ({ access, principal, params, meta }) => {
      const { endpoint, secret } = await rotateSecret(
        ctx.db,
        {
          organizationId: orgIdOf(access),
          endpointId: params.endpointId,
          actor: actorOf(principal),
          box,
        },
        meta,
      );
      return { endpoint: toEndpoint(endpoint), secret, warning: shownOnce };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/organizations/:orgId/webhooks/:endpointId/test',
    summary: 'Send a test event to this endpoint',
    tags,
    auth: 'session_or_api_key',
    org: 'webhook:manage',
    params: endpointParams,
    response: z.object({ eventId: z.string() }),
    successStatus: 202,
    handler: async ({ access, principal, params, meta }) =>
      sendTest(
        ctx.db,
        {
          organizationId: orgIdOf(access),
          endpointId: params.endpointId,
          actor: actorOf(principal),
        },
        meta,
      ),
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/webhooks/:endpointId/deliveries',
    summary: 'Recent deliveries for an endpoint (newest first)',
    tags,
    auth: 'session_or_api_key',
    org: 'webhook:read',
    params: endpointParams,
    query: z.object({
      limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
      cursor: z.string().max(500).optional(),
      status: z.enum(['pending', 'delivered', 'failed']).optional(),
    }),
    response: z.object({ data: z.array(deliverySchema), nextCursor: z.string().nullable() }),
    handler: async ({ access, params, query }) => {
      const organizationId = orgIdOf(access);
      await getEndpoint(ctx.db, organizationId, params.endpointId);
      const before = query.cursor ? decodeCursor(query.cursor, ['createdAt', 'id']) : undefined;
      const rows = await listDeliveries(ctx.db, {
        organizationId,
        endpointId: params.endpointId,
        limit: query.limit + 1,
        ...(query.status ? { status: query.status } : {}),
        ...(before ? { before } : {}),
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        data: page.map(toDelivery),
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id })
            : null,
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/organizations/:orgId/webhook-deliveries/:deliveryId/redeliver',
    summary: 'Send a delivery again',
    tags,
    auth: 'session_or_api_key',
    org: 'webhook:manage',
    idempotency: 'optional',
    params: deliveryParams,
    response: z.object({ queued: z.boolean() }),
    successStatus: 202,
    handler: async ({ access, principal, params, meta }) => {
      await redeliver(
        ctx.db,
        {
          organizationId: orgIdOf(access),
          deliveryId: params.deliveryId,
          actor: actorOf(principal),
        },
        meta,
      );
      return { queued: true };
    },
  });
}
