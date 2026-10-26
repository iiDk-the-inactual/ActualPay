/**
 * Notification settings: each member's own preferences, and optional
 * forwarding of organization notifications to outside addresses (which the
 * address owner must confirm by email).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OrgAccess } from '@actualpay/auth';
import { AppError } from '@actualpay/shared';
import {
  addForward,
  KIND_INFO,
  listForwards,
  listPreferences,
  NOTIFICATION_KINDS,
  removeForward,
  setPreference,
  verifyForward,
} from '@actualpay/notifications';
import type { ApiContext } from '../http/context';
import type { Principal } from '../http/principal';
import { defineRoute } from '../http/route';
import { empty, isoDate, nullableIsoDate, orgParams, tokenInput, uuid } from './schemas';

function orgIdOf(access: OrgAccess | null): string {
  if (!access) throw AppError.notFound('Organization');
  return access.organizationId;
}
function userIdOf(principal: Principal | null): string {
  if (principal?.kind !== 'session') throw AppError.unauthenticated();
  return principal.session.userId;
}

const kindEnum = z.enum(NOTIFICATION_KINDS);
const forwardSchema = z.object({
  id: z.string(),
  email: z.string(),
  kinds: z.array(z.string()),
  status: z.enum(['pending', 'active']),
  verifiedAt: nullableIsoDate,
  createdAt: isoDate,
});

export function registerNotificationRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const tags = ['notifications'];

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/notifications',
    summary: 'Your notification preferences and the organization’s forwarding addresses',
    tags,
    auth: 'session',
    org: 'org:read',
    params: orgParams,
    response: z.object({
      preferences: z.array(
        z.object({
          kind: kindEnum,
          label: z.string(),
          enabled: z.boolean(),
          isDefault: z.boolean(),
          applicable: z.boolean(),
        }),
      ),
      forwards: z.array(forwardSchema),
    }),
    handler: async ({ access, principal }) => {
      const organizationId = orgIdOf(access);
      const preferences = await listPreferences(ctx.db, {
        userId: userIdOf(principal),
        organizationId,
        role: access?.role ?? 'viewer',
      });
      const forwards = await listForwards(ctx.db, organizationId);
      return {
        preferences,
        forwards: forwards.map((f) => ({
          id: f.id,
          email: f.email,
          kinds: f.kinds,
          status: f.status === 'active' ? ('active' as const) : ('pending' as const),
          verifiedAt: f.verified_at,
          createdAt: f.created_at,
        })),
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'PUT',
    url: '/v1/organizations/:orgId/notifications/preferences/:kind',
    summary: 'Turn one kind of notification on or off for yourself',
    tags,
    auth: 'session',
    org: 'org:read',
    params: orgParams.extend({ kind: kindEnum }),
    body: z.object({ enabled: z.boolean() }).strict(),
    response: z.object({ kind: kindEnum, enabled: z.boolean() }),
    successStatus: 200,
    handler: async ({ access, principal, params, body }) => {
      await setPreference(ctx.db, {
        userId: userIdOf(principal),
        organizationId: orgIdOf(access),
        kind: params.kind,
        enabled: body.enabled,
      });
      return { kind: params.kind, enabled: body.enabled };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/organizations/:orgId/notification-forwards',
    summary: 'Forward notifications to another address (it must confirm by email first)',
    tags,
    auth: 'session',
    org: 'settings:manage',
    requireMfa: true,
    rateLimit: 'auth',
    params: orgParams,
    body: z
      .object({
        email: z.string().trim().min(3).max(254),
        kinds: z.array(kindEnum).min(1).max(5),
      })
      .strict(),
    response: z.object({ id: z.string(), status: z.literal('pending') }),
    successStatus: 202,
    handler: async ({ access, principal, body, meta }) => {
      const { id } = await addForward({
        db: ctx.db,
        mailer: ctx.auth.mailer,
        logger: ctx.logger,
        organizationId: orgIdOf(access),
        userId: userIdOf(principal),
        email: body.email,
        kinds: body.kinds,
        appName: ctx.config.appName,
        baseUrl: ctx.config.publicBaseUrl.toString(),
        meta,
      });
      return { id, status: 'pending' as const };
    },
  });

  defineRoute(app, ctx, {
    method: 'DELETE',
    url: '/v1/organizations/:orgId/notification-forwards/:forwardId',
    summary: 'Stop forwarding to an address',
    tags,
    auth: 'session',
    org: 'settings:manage',
    params: orgParams.extend({ forwardId: uuid }),
    response: empty,
    successStatus: 204,
    handler: async ({ access, principal, params, meta }) => {
      await removeForward(
        ctx.db,
        {
          organizationId: orgIdOf(access),
          forwardId: params.forwardId,
          userId: userIdOf(principal),
        },
        meta,
      );
      return null;
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/notification-forwards/confirm',
    summary: 'Confirm a forwarding address from the link in the email (no login)',
    tags,
    auth: 'public',
    rateLimit: 'auth',
    body: z.object({ token: tokenInput }).strict(),
    response: z.object({ confirmed: z.literal(true) }),
    successStatus: 200,
    handler: async ({ body, meta }) => {
      await verifyForward(ctx.db, body.token, meta);
      return { confirmed: true as const };
    },
  });

  // The labels are static; exposing them lets the dashboard stay in sync.
  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/notification-kinds',
    summary: 'Kinds of notification and who can receive them',
    tags,
    auth: 'public',
    response: z.object({
      data: z.array(z.object({ kind: kindEnum, label: z.string(), roles: z.array(z.string()) })),
    }),
    handler: () =>
      Promise.resolve({
        data: NOTIFICATION_KINDS.map((kind) => ({
          kind,
          label: KIND_INFO[kind].label,
          roles: [...KIND_INFO[kind].roles],
        })),
      }),
  });
}
