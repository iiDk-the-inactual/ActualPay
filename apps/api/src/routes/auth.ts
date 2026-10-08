/**
 * Public authentication endpoints. All are rate limited per IP and return
 * enumeration-safe responses (see packages/auth/src/services/users.ts).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AppError } from '@actualpay/shared';
import {
  authenticatePassword,
  consumeTokenById,
  createSession,
  csrfTokenFor,
  getPublicUser,
  issueAuthToken,
  registerUser,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  revokeSession,
  touchMfaChallenge,
  verifyEmail,
  verifySecondFactor,
} from '@actualpay/auth';
import { inTransaction } from '@actualpay/database';
import { recordAudit, type RequestMeta } from '@actualpay/audit';
import type { ApiContext } from '../http/context';
import { defineRoute } from '../http/route';
import { sessionCookieName } from '../http/principal';
import { codeInput, emailInput, empty, passwordInput, tokenInput, userSchema } from './schemas';

const authenticated = z.object({
  status: z.literal('authenticated'),
  user: userSchema,
  csrfToken: z.string(),
});
const mfaRequired = z.object({ status: z.literal('mfa_required'), mfaToken: z.string() });

export function setSessionCookie(ctx: ApiContext, reply: FastifyReply, token: string): void {
  reply.setCookie(sessionCookieName(ctx.secureCookies), token, {
    httpOnly: true,
    secure: ctx.secureCookies,
    sameSite: 'strict',
    path: '/',
    maxAge: ctx.config.sessionPolicy.absoluteHours * 3600,
  });
}

export function clearSessionCookie(ctx: ApiContext, reply: FastifyReply): void {
  reply.clearCookie(sessionCookieName(ctx.secureCookies), {
    path: '/',
    secure: ctx.secureCookies,
    httpOnly: true,
    sameSite: 'strict',
  });
}

async function startSession(
  ctx: ApiContext,
  reply: FastifyReply,
  userId: string,
  mfaVerified: boolean,
  meta: RequestMeta,
) {
  const { token, sessionId } = await inTransaction(ctx.db, async (tx) => {
    const created = await createSession(ctx.auth, tx, { userId, mfaVerified, meta });
    await recordAudit(tx, {
      actor: { type: 'user', id: userId },
      action: 'user.login.succeeded',
      target: { type: 'session', id: created.sessionId },
      meta,
      metadata: { mfa: mfaVerified },
    });
    return created;
  });
  setSessionCookie(ctx, reply, token);
  return {
    status: 'authenticated' as const,
    user: await getPublicUser(ctx.auth, userId),
    csrfToken: csrfTokenFor(ctx.csrfKey, sessionId),
  };
}

export function registerAuthRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const tags = ['auth'];

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/auth/register',
    summary: 'Create an account (always responds 202)',
    tags,
    auth: 'public',
    rateLimit: 'auth',
    body: z.object({
      email: emailInput,
      password: passwordInput,
      displayName: z.string().trim().min(1).max(100),
    }),
    response: z.object({ status: z.literal('verification_pending') }),
    successStatus: 202,
    handler: async ({ body, meta }) => {
      await registerUser(ctx.auth, body, meta);
      return { status: 'verification_pending' as const };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/auth/verify-email',
    summary: 'Verify an email address with the emailed token',
    tags,
    auth: 'public',
    rateLimit: 'auth',
    body: z.object({ token: tokenInput }),
    response: z.object({ verified: z.literal(true) }),
    successStatus: 200,
    handler: async ({ body, meta }) => {
      await verifyEmail(ctx.auth, body.token, meta);
      return { verified: true as const };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/auth/resend-verification',
    summary: 'Resend the verification email (always 202)',
    tags,
    auth: 'public',
    rateLimit: 'auth',
    body: z.object({ email: emailInput }),
    response: z.object({ status: z.literal('accepted') }),
    successStatus: 202,
    handler: async ({ body }) => {
      await resendVerification(ctx.auth, body.email);
      return { status: 'accepted' as const };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/auth/login',
    summary: 'Sign in with email and password',
    tags,
    auth: 'public',
    rateLimit: 'auth',
    body: z.object({ email: emailInput, password: passwordInput }),
    response: z.union([authenticated, mfaRequired]),
    successStatus: 200,
    handler: async ({ body, meta, reply }) => {
      const result = await authenticatePassword(ctx.auth, body, meta);
      if (result.kind === 'invalid')
        throw AppError.unauthenticated(
          'Invalid email or password, or the account is temporarily locked.',
        );
      if (result.kind === 'unverified')
        throw new AppError('EMAIL_NOT_VERIFIED', 'Verify your email address before signing in.');
      if (result.mfaEnabled) {
        const mfaToken = await issueAuthToken(ctx.db, result.userId, 'mfa_challenge');
        return { status: 'mfa_required' as const, mfaToken };
      }
      return startSession(ctx, reply, result.userId, false, meta);
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/auth/login/mfa',
    summary: 'Complete sign-in with a TOTP or recovery code',
    tags,
    auth: 'public',
    rateLimit: 'auth',
    body: z.object({ mfaToken: tokenInput, code: codeInput }),
    response: authenticated,
    successStatus: 200,
    handler: async ({ body, meta, reply }) => {
      // Each attempt counts against the challenge; it dies after 5 tries or 5 minutes.
      const challenge = await touchMfaChallenge(ctx.db, body.mfaToken);
      if (!challenge)
        throw AppError.unauthenticated(
          'The sign-in challenge is invalid or has expired. Sign in again.',
        );
      const factor = await inTransaction(ctx.db, async (tx) => {
        const used = await verifySecondFactor(ctx.auth, tx, {
          userId: challenge.userId,
          code: body.code,
        });
        if (used === 'recovery_code') {
          await recordAudit(tx, {
            actor: { type: 'user', id: challenge.userId },
            action: 'user.mfa.recovery_code_used',
            target: { type: 'user', id: challenge.userId },
            meta,
          });
        }
        return used;
      });
      if (!factor) throw AppError.unauthenticated('The code is incorrect.');
      if (!(await consumeTokenById(ctx.db, challenge.id)))
        throw AppError.unauthenticated('The sign-in challenge was already used.');
      return startSession(ctx, reply, challenge.userId, true, meta);
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/auth/logout',
    summary: 'Sign out the current session',
    tags,
    auth: 'session',
    response: empty,
    successStatus: 204,
    handler: async ({ principal, reply, meta }) => {
      if (principal?.kind !== 'session') throw AppError.unauthenticated();
      await revokeSession(ctx.db, {
        sessionId: principal.session.sessionId,
        userId: principal.session.userId,
        reason: 'logout',
      });
      await recordAudit(ctx.db, {
        actor: { type: 'user', id: principal.session.userId },
        action: 'user.logout',
        target: { type: 'session', id: principal.session.sessionId },
        meta,
      });
      clearSessionCookie(ctx, reply);
      return null;
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/auth/password/forgot',
    summary: 'Request a password reset email (always 202)',
    tags,
    auth: 'public',
    rateLimit: 'auth',
    body: z.object({ email: emailInput }),
    response: z.object({ status: z.literal('accepted') }),
    successStatus: 202,
    handler: async ({ body, meta }) => {
      await requestPasswordReset(ctx.auth, body.email, meta);
      return { status: 'accepted' as const };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/auth/password/reset',
    summary: 'Set a new password using a reset token',
    tags,
    auth: 'public',
    rateLimit: 'auth',
    body: z.object({ token: tokenInput, newPassword: passwordInput }),
    response: empty,
    successStatus: 204,
    handler: async ({ body, meta }) => {
      await resetPassword(ctx.auth, body, meta);
      return null;
    },
  });
}
