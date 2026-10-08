/** Organization, membership, invitation, API key and audit-log endpoints. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  encodeCursor,
  MAX_PAGE_SIZE,
} from '@actualpay/shared';
import {
  changeMemberRole,
  createApiKey,
  createInvitation,
  createOrganization,
  getOrganization,
  listApiKeys,
  listInvitations,
  listMembers,
  removeMember,
  revokeApiKey,
  revokeInvitation,
  rotateApiKey,
  updateOrganization,
  API_KEY_MAX_ROTATION_GRACE_HOURS,
  type OrgAccess,
  type SessionPrincipal,
} from '@actualpay/auth';
import type { OrgRole } from '@actualpay/database';
import type { ApiContext } from '../http/context';
import { auditActor, type Principal } from '../http/principal';
import { defineRoute } from '../http/route';
import {
  empty,
  isoDate,
  nullableIsoDate,
  orgParams,
  organizationSchema,
  roleSchema,
  scopeSchema,
  uuid,
} from './schemas';

function sessionOf(principal: Principal | null): SessionPrincipal {
  if (principal?.kind !== 'session') throw AppError.unauthenticated();
  return principal.session;
}

function memberRole(access: OrgAccess | null): OrgRole {
  if (!access?.role) throw AppError.forbidden();
  return access.role;
}

function orgIdOf(access: OrgAccess | null): string {
  if (!access) throw AppError.notFound('Organization');
  return access.organizationId;
}

const toOrg = (r: {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  created_at: Date;
}) => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  status: r.status,
  createdAt: r.created_at,
});

const apiKeySchema = z.object({
  id: z.string(),
  prefix: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  createdBy: z.string(),
  createdAt: isoDate,
  expiresAt: nullableIsoDate,
  revokedAt: nullableIsoDate,
  lastUsedAt: nullableIsoDate,
  rotatedFromId: z.string().nullable(),
});

export function registerOrganizationRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const tags = ['organizations'];
  const keyPrefix = (publicId: string) =>
    `apk_${ctx.config.network === 'mainnet' ? 'live' : 'test'}_${publicId}`;

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/organizations',
    summary: 'Create an organization (you become its owner)',
    tags,
    auth: 'session',
    body: z.object({
      name: z.string().trim().min(1).max(200),
      slug: z.string().trim().min(3).max(63).optional(),
    }),
    response: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
    handler: async ({ principal, body, meta }) =>
      createOrganization(
        ctx.auth,
        {
          userId: sessionOf(principal).userId,
          name: body.name,
          ...(body.slug ? { slug: body.slug } : {}),
        },
        meta,
      ),
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId',
    summary: 'Get an organization',
    tags,
    auth: 'session',
    org: 'org:read',
    params: orgParams,
    response: organizationSchema,
    handler: async ({ access }) => toOrg(await getOrganization(ctx.db, orgIdOf(access))),
  });

  defineRoute(app, ctx, {
    method: 'PATCH',
    url: '/v1/organizations/:orgId',
    summary: 'Rename an organization',
    tags,
    auth: 'session',
    org: 'org:update',
    params: orgParams,
    body: z.object({ name: z.string().trim().min(1).max(200) }),
    response: organizationSchema,
    handler: async ({ access, principal, body, meta }) => {
      if (!principal) throw AppError.unauthenticated();
      return toOrg(
        await updateOrganization(
          ctx.db,
          { organizationId: orgIdOf(access), name: body.name, actor: auditActor(principal) },
          meta,
        ),
      );
    },
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/access',
    summary: 'Describe the caller\u2019s access (works with API keys)',
    tags,
    auth: 'session_or_api_key',
    org: true,
    params: orgParams,
    response: z.object({
      organizationId: z.string(),
      via: z.enum(['member', 'api_key']),
      role: roleSchema.nullable(),
      permissions: z.array(z.string()),
    }),
    handler: ({ access }) => {
      if (!access) throw AppError.notFound('Organization');
      return Promise.resolve({
        organizationId: access.organizationId,
        via: access.via,
        role: access.role,
        permissions: [...access.permissions].sort(),
      });
    },
  });

  // --- Members --------------------------------------------------------------

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/members',
    summary: 'List members',
    tags,
    auth: 'session',
    org: 'member:read',
    params: orgParams,
    response: z.object({
      data: z.array(
        z.object({
          userId: z.string(),
          email: z.string(),
          displayName: z.string(),
          role: roleSchema,
          joinedAt: isoDate,
        }),
      ),
    }),
    handler: async ({ access }) => ({ data: await listMembers(ctx.db, orgIdOf(access)) }),
  });

  defineRoute(app, ctx, {
    method: 'PATCH',
    url: '/v1/organizations/:orgId/members/:userId',
    summary: 'Change a member\u2019s role',
    tags,
    auth: 'session',
    org: 'member:manage',
    params: orgParams.extend({ userId: uuid }),
    body: z.object({ role: roleSchema }),
    response: empty,
    successStatus: 204,
    handler: async ({ access, principal, params, body, meta }) => {
      await changeMemberRole(
        ctx.db,
        {
          organizationId: orgIdOf(access),
          actorUserId: sessionOf(principal).userId,
          actorRole: memberRole(access),
          targetUserId: params.userId,
          newRole: body.role,
        },
        meta,
      );
      return null;
    },
  });

  defineRoute(app, ctx, {
    method: 'DELETE',
    url: '/v1/organizations/:orgId/members/:userId',
    summary: 'Remove a member, or leave (own user id)',
    tags,
    auth: 'session',
    org: true,
    params: orgParams.extend({ userId: uuid }),
    response: empty,
    successStatus: 204,
    handler: async ({ access, principal, params, meta }) => {
      const session = sessionOf(principal);
      if (params.userId !== session.userId && !access?.permissions.has('member:manage'))
        throw AppError.forbidden('Missing permission: member:manage');
      await removeMember(
        ctx.db,
        {
          organizationId: orgIdOf(access),
          actorUserId: session.userId,
          actorRole: memberRole(access),
          targetUserId: params.userId,
        },
        meta,
      );
      return null;
    },
  });

  // --- Invitations ----------------------------------------------------------

  const invitationSchema = z.object({
    id: z.string(),
    email: z.string(),
    role: roleSchema,
    expiresAt: isoDate,
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/organizations/:orgId/invitations',
    summary: 'Invite someone by email',
    tags,
    auth: 'session',
    org: 'member:manage',
    rateLimit: 'auth',
    params: orgParams,
    body: z.object({ email: z.string().trim().min(3).max(254), role: roleSchema }),
    response: invitationSchema,
    handler: async ({ access, principal, body, meta }) =>
      createInvitation(
        ctx.auth,
        {
          organizationId: orgIdOf(access),
          actorUserId: sessionOf(principal).userId,
          actorRole: memberRole(access),
          email: body.email,
          role: body.role,
        },
        meta,
      ),
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/invitations',
    summary: 'List pending invitations',
    tags,
    auth: 'session',
    org: 'member:read',
    params: orgParams,
    response: z.object({ data: z.array(invitationSchema.extend({ createdAt: isoDate })) }),
    handler: async ({ access }) => {
      const rows = await listInvitations(ctx.db, orgIdOf(access));
      return {
        data: rows.map((r) => ({
          id: r.id,
          email: r.email,
          role: r.role,
          createdAt: r.created_at,
          expiresAt: r.expires_at,
        })),
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'DELETE',
    url: '/v1/organizations/:orgId/invitations/:invitationId',
    summary: 'Revoke an invitation',
    tags,
    auth: 'session',
    org: 'member:manage',
    params: orgParams.extend({ invitationId: uuid }),
    response: empty,
    successStatus: 204,
    handler: async ({ access, principal, params, meta }) => {
      await revokeInvitation(
        ctx.db,
        {
          organizationId: orgIdOf(access),
          invitationId: params.invitationId,
          actorUserId: sessionOf(principal).userId,
          actorRole: memberRole(access),
        },
        meta,
      );
      return null;
    },
  });

  // --- API keys -------------------------------------------------------------

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/api-keys',
    summary: 'List API keys (secrets are never returned)',
    tags: ['api-keys'],
    auth: 'session',
    org: 'apikey:read',
    params: orgParams,
    response: z.object({ data: z.array(apiKeySchema) }),
    handler: async ({ access }) => {
      const rows = await listApiKeys(ctx.db, orgIdOf(access));
      return {
        data: rows.map((r) => ({
          id: r.id,
          prefix: keyPrefix(r.public_id),
          name: r.name,
          scopes: r.scopes,
          createdBy: r.created_by,
          createdAt: r.created_at,
          expiresAt: r.expires_at,
          revokedAt: r.revoked_at,
          lastUsedAt: r.last_used_at,
          rotatedFromId: r.rotated_from_id,
        })),
      };
    },
  });

  const createdKeySchema = z.object({
    id: z.string(),
    prefix: z.string(),
    key: z.string(),
    warning: z.string(),
  });
  const shownOnce = 'Store this key now. It cannot be retrieved again.';

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/organizations/:orgId/api-keys',
    summary: 'Create an API key (secret shown once)',
    tags: ['api-keys'],
    auth: 'session',
    org: 'apikey:manage',
    idempotency: 'optional',
    params: orgParams,
    body: z.object({
      name: z.string().trim().min(1).max(100),
      scopes: z.array(scopeSchema).min(1).max(32),
      expiresAt: z.coerce.date().optional(),
    }),
    response: createdKeySchema,
    handler: async ({ access, principal, body, meta }) => {
      const session = sessionOf(principal);
      const created = await createApiKey(
        ctx.db,
        {
          organizationId: orgIdOf(access),
          network: ctx.config.network,
          creator: {
            userId: session.userId,
            role: memberRole(access),
            mfaVerified: session.mfaVerified,
          },
          name: body.name,
          scopes: body.scopes,
          ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
        },
        meta,
      );
      return {
        id: created.id,
        prefix: keyPrefix(created.publicId),
        key: created.key,
        warning: shownOnce,
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/organizations/:orgId/api-keys/:keyId/rotate',
    summary: 'Rotate an API key',
    tags: ['api-keys'],
    auth: 'session',
    org: 'apikey:manage',
    params: orgParams.extend({ keyId: uuid }),
    body: z.object({
      graceHours: z.number().int().min(0).max(API_KEY_MAX_ROTATION_GRACE_HOURS).default(24),
    }),
    response: createdKeySchema.extend({ oldKeyExpiresAt: nullableIsoDate }),
    handler: async ({ access, principal, params, body, meta }) => {
      const session = sessionOf(principal);
      const rotated = await rotateApiKey(
        ctx.db,
        {
          organizationId: orgIdOf(access),
          network: ctx.config.network,
          apiKeyId: params.keyId,
          creator: {
            userId: session.userId,
            role: memberRole(access),
            mfaVerified: session.mfaVerified,
          },
          graceHours: body.graceHours,
        },
        meta,
      );
      return {
        id: rotated.id,
        prefix: keyPrefix(rotated.publicId),
        key: rotated.key,
        warning: shownOnce,
        oldKeyExpiresAt: rotated.oldKeyExpiresAt,
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'DELETE',
    url: '/v1/organizations/:orgId/api-keys/:keyId',
    summary: 'Revoke an API key',
    tags: ['api-keys'],
    auth: 'session',
    org: 'apikey:manage',
    params: orgParams.extend({ keyId: uuid }),
    response: empty,
    successStatus: 204,
    handler: async ({ access, principal, params, meta }) => {
      await revokeApiKey(
        ctx.db,
        {
          organizationId: orgIdOf(access),
          apiKeyId: params.keyId,
          actorUserId: sessionOf(principal).userId,
        },
        meta,
      );
      return null;
    },
  });

  // --- Audit log ------------------------------------------------------------

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/audit-log',
    summary: 'Organization audit log (cursor-paginated, newest first)',
    tags: ['audit'],
    auth: 'session',
    org: 'audit:read',
    params: orgParams,
    query: z.object({
      limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
      cursor: z.string().max(500).optional(),
      action: z.string().max(100).optional(),
    }),
    response: z.object({
      data: z.array(
        z.object({
          id: z.string(),
          occurredAt: isoDate,
          actorType: z.string(),
          actorId: z.string().nullable(),
          action: z.string(),
          targetType: z.string().nullable(),
          targetId: z.string().nullable(),
          requestId: z.string().nullable(),
          ipAddress: z.string().nullable(),
          metadata: z.record(z.unknown()),
        }),
      ),
      nextCursor: z.string().nullable(),
    }),
    handler: async ({ access, query }) => {
      let q = ctx.db
        .selectFrom('audit_log')
        .select([
          'id',
          'occurred_at',
          'actor_type',
          'actor_id',
          'action',
          'target_type',
          'target_id',
          'request_id',
          'ip_address',
          'metadata',
        ])
        .where('organization_id', '=', orgIdOf(access))
        .orderBy('id', 'desc')
        .limit(query.limit + 1);
      if (query.cursor) {
        const { id } = decodeCursor(query.cursor, ['id']);
        if (!/^[0-9]{1,19}$/.test(id)) throw AppError.validation('Invalid pagination cursor.');
        q = q.where('id', '<', id);
      }
      if (query.action) q = q.where('action', '=', query.action);
      const rows = await q.execute();
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        data: page.map((r) => ({
          id: r.id,
          occurredAt: r.occurred_at,
          actorType: r.actor_type,
          actorId: r.actor_id,
          action: r.action,
          targetType: r.target_type,
          targetId: r.target_id,
          requestId: r.request_id,
          ipAddress: r.ip_address,
          metadata: r.metadata,
        })),
        nextCursor: rows.length > query.limit && last ? encodeCursor({ id: last.id }) : null,
      };
    },
  });
}
