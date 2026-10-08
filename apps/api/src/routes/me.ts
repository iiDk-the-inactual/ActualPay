/** Endpoints for the signed-in user: profile, sessions, password, 2FA, invitations. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@actualpay/shared';
import {
  acceptInvitation,
  changePassword,
  confirmTotpEnrollment,
  csrfTokenFor,
  disableTotp,
  getPublicUser,
  listActiveSessions,
  listOrganizationsForUser,
  regenerateRecoveryCodes,
  remainingRecoveryCodes,
  revokeAllSessions,
  revokeSession,
  startTotpEnrollment,
  type SessionPrincipal,
} from '@actualpay/auth';
import { recordAudit } from '@actualpay/audit';
import type { ApiContext } from '../http/context';
import type { Principal } from '../http/principal';
import { defineRoute } from '../http/route';
import {
  codeInput,
  empty,
  isoDate,
  passwordInput,
  roleSchema,
  tokenInput,
  userSchema,
  uuid,
} from './schemas';

function sessionOf(principal: Principal | null): SessionPrincipal {
  if (principal?.kind !== 'session') throw AppError.unauthenticated();
  return principal.session;
}

export function registerMeRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const tags = ['me'];

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/me',
    summary: 'Current user, 2FA status and CSRF token',
    tags,
    auth: 'session',
    response: z.object({
      user: userSchema,
      mfaEnabled: z.boolean(),
      mfaVerified: z.boolean(),
      recoveryCodesRemaining: z.number().int(),
      csrfToken: z.string(),
    }),
    handler: async ({ principal }) => {
      const session = sessionOf(principal);
      return {
        user: await getPublicUser(ctx.auth, session.userId),
        mfaEnabled: session.mfaEnabled,
        mfaVerified: session.mfaVerified,
        recoveryCodesRemaining: session.mfaEnabled
          ? await remainingRecoveryCodes(ctx.db, session.userId)
          : 0,
        csrfToken: csrfTokenFor(ctx.csrfKey, session.sessionId),
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/me/password',
    summary: 'Change password (signs out other sessions)',
    tags,
    auth: 'session',
    rateLimit: 'auth',
    body: z.object({ currentPassword: passwordInput, newPassword: passwordInput }),
    response: empty,
    successStatus: 204,
    handler: async ({ principal, body, meta }) => {
      const session = sessionOf(principal);
      await changePassword(
        ctx.auth,
        { userId: session.userId, currentSessionId: session.sessionId, ...body },
        meta,
      );
      return null;
    },
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/me/sessions',
    summary: 'List active sessions',
    tags,
    auth: 'session',
    response: z.object({
      data: z.array(
        z.object({
          id: z.string(),
          current: z.boolean(),
          createdAt: isoDate,
          lastSeenAt: isoDate,
          expiresAt: isoDate,
          ipAddress: z.string().nullable(),
          userAgent: z.string().nullable(),
          mfaVerified: z.boolean(),
        }),
      ),
    }),
    handler: async ({ principal }) => {
      const session = sessionOf(principal);
      const rows = await listActiveSessions(ctx.db, session.userId);
      return {
        data: rows.map((r) => ({
          id: r.id,
          current: r.id === session.sessionId,
          createdAt: r.created_at,
          lastSeenAt: r.last_seen_at,
          expiresAt: r.expires_at,
          ipAddress: r.ip_address,
          userAgent: r.user_agent,
          mfaVerified: r.mfa_verified,
        })),
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'DELETE',
    url: '/v1/me/sessions/:sessionId',
    summary: 'Revoke one of your sessions',
    tags,
    auth: 'session',
    params: z.object({ sessionId: uuid }),
    response: empty,
    successStatus: 204,
    handler: async ({ principal, params, meta }) => {
      const session = sessionOf(principal);
      // Scoped to the caller's own sessions: other users' ids look nonexistent.
      if (
        !(await revokeSession(ctx.db, {
          sessionId: params.sessionId,
          userId: session.userId,
          reason: 'user_revoked',
        }))
      )
        throw AppError.notFound('Session');
      await recordAudit(ctx.db, {
        actor: { type: 'user', id: session.userId },
        action: 'user.session.revoked',
        target: { type: 'session', id: params.sessionId },
        meta,
      });
      return null;
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/me/sessions/revoke-others',
    summary: 'Sign out every other session',
    tags,
    auth: 'session',
    response: z.object({ revoked: z.number().int() }),
    successStatus: 200,
    handler: async ({ principal, meta }) => {
      const session = sessionOf(principal);
      const revoked = await revokeAllSessions(ctx.db, {
        userId: session.userId,
        reason: 'user_revoked_others',
        exceptSessionId: session.sessionId,
      });
      await recordAudit(ctx.db, {
        actor: { type: 'user', id: session.userId },
        action: 'user.session.revoked_others',
        target: { type: 'user', id: session.userId },
        meta,
        metadata: { revoked },
      });
      return { revoked };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/me/mfa/totp/setup',
    summary: 'Begin TOTP enrollment',
    tags,
    auth: 'session',
    rateLimit: 'auth',
    response: z.object({ secret: z.string(), otpauthUri: z.string() }),
    successStatus: 200,
    handler: async ({ principal }) => startTotpEnrollment(ctx.auth, sessionOf(principal).userId),
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/me/mfa/totp/confirm',
    summary: 'Confirm TOTP enrollment; returns recovery codes once',
    tags,
    auth: 'session',
    rateLimit: 'auth',
    body: z.object({ code: codeInput }),
    response: z.object({ recoveryCodes: z.array(z.string()) }),
    successStatus: 200,
    handler: async ({ principal, body, meta }) => {
      const session = sessionOf(principal);
      return {
        recoveryCodes: await confirmTotpEnrollment(
          ctx.auth,
          { userId: session.userId, currentSessionId: session.sessionId, code: body.code },
          meta,
        ),
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/me/mfa/totp/disable',
    summary: 'Disable TOTP (password and code required)',
    tags,
    auth: 'session',
    rateLimit: 'auth',
    body: z.object({ password: passwordInput, code: codeInput }),
    response: empty,
    successStatus: 204,
    handler: async ({ principal, body, meta }) => {
      const session = sessionOf(principal);
      await disableTotp(
        ctx.auth,
        { userId: session.userId, currentSessionId: session.sessionId, ...body },
        meta,
      );
      return null;
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/me/mfa/recovery-codes',
    summary: 'Replace recovery codes (authenticator code required)',
    tags,
    auth: 'session',
    rateLimit: 'auth',
    body: z.object({ code: codeInput }),
    response: z.object({ recoveryCodes: z.array(z.string()) }),
    successStatus: 200,
    handler: async ({ principal, body, meta }) => ({
      recoveryCodes: await regenerateRecoveryCodes(
        ctx.auth,
        { userId: sessionOf(principal).userId, code: body.code },
        meta,
      ),
    }),
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/me/organizations',
    summary: 'Organizations you belong to',
    tags,
    auth: 'session',
    response: z.object({
      data: z.array(
        z.object({
          id: z.string(),
          slug: z.string(),
          name: z.string(),
          status: z.enum(['active', 'suspended']),
          role: roleSchema,
          createdAt: isoDate,
        }),
      ),
    }),
    handler: async ({ principal }) => {
      const rows = await listOrganizationsForUser(ctx.db, sessionOf(principal).userId);
      return {
        data: rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          status: r.status,
          role: r.role,
          createdAt: r.created_at,
        })),
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/invitations/accept',
    summary: 'Accept an organization invitation',
    tags: ['organizations'],
    auth: 'session',
    rateLimit: 'auth',
    body: z.object({ token: tokenInput }),
    response: z.object({ organizationId: z.string(), role: roleSchema }),
    successStatus: 200,
    handler: async ({ principal, body, meta }) =>
      acceptInvitation(ctx.db, { userId: sessionOf(principal).userId, token: body.token }, meta),
  });
}
