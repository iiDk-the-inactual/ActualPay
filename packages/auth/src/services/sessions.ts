/**
 * Server-side sessions identified by an opaque 256-bit token held in an
 * HttpOnly cookie. The database stores only the token's SHA-256, so a
 * database leak does not yield usable sessions. Sessions have both an idle
 * timeout (sliding) and an absolute lifetime, and every security-relevant
 * event (password change/reset, MFA change, disable) revokes them.
 */
import { sql } from 'kysely';
import type { Db } from '@actualpay/database';
import type { RequestMeta } from '@actualpay/audit';
import { hmacSha256Hex, randomToken, safeEqual, sha256Hex } from '../crypto';
import type { AuthDeps } from './deps';

export interface SessionPrincipal {
  readonly sessionId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly mfaVerified: boolean;
  readonly mfaEnabled: boolean;
  readonly isPlatformAdmin: boolean;
}

export async function createSession(
  deps: AuthDeps,
  db: Db,
  params: { userId: string; mfaVerified: boolean; meta: RequestMeta },
): Promise<{ token: string; sessionId: string }> {
  const token = randomToken(32);
  const { idleMinutes, absoluteHours } = deps.sessionPolicy;
  const row = await db
    .insertInto('sessions')
    .values({
      user_id: params.userId,
      token_hash: sha256Hex(token),
      mfa_verified: params.mfaVerified,
      idle_expires_at: sql<Date>`least(now() + make_interval(mins => ${idleMinutes}), now() + make_interval(hours => ${absoluteHours}))`,
      expires_at: sql<Date>`now() + make_interval(hours => ${absoluteHours})`,
      ip_address: params.meta.ip ?? null,
      user_agent: params.meta.userAgent?.slice(0, 512) ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { token, sessionId: row.id };
}

/**
 * Resolve a session token. Extends the idle window at most once per minute
 * to avoid a write on every request.
 */
export async function validateSession(
  deps: AuthDeps,
  token: string,
): Promise<SessionPrincipal | null> {
  if (token.length < 20 || token.length > 100) return null;
  const row = await deps.db
    .selectFrom('sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .leftJoin('totp_credentials as t', 't.user_id', 'u.id')
    .select([
      's.id as sessionId',
      's.user_id as userId',
      's.mfa_verified as mfaVerified',
      's.last_seen_at as lastSeenAt',
      'u.email',
      'u.display_name as displayName',
      'u.is_platform_admin as isPlatformAdmin',
      't.confirmed_at as mfaConfirmedAt',
    ])
    .where('s.token_hash', '=', sha256Hex(token))
    .where('s.revoked_at', 'is', null)
    .where('s.expires_at', '>', sql<Date>`now()`)
    .where('s.idle_expires_at', '>', sql<Date>`now()`)
    .where('u.status', '=', 'active')
    .executeTakeFirst();
  if (!row) return null;

  if (Date.now() - row.lastSeenAt.getTime() > 60_000) {
    await deps.db
      .updateTable('sessions')
      .set({
        last_seen_at: sql`now()`,
        idle_expires_at: sql`least(now() + make_interval(mins => ${deps.sessionPolicy.idleMinutes}), expires_at)`,
      })
      .where('id', '=', row.sessionId)
      .execute();
  }
  return {
    sessionId: row.sessionId,
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
    mfaVerified: row.mfaVerified,
    mfaEnabled: row.mfaConfirmedAt !== null,
    isPlatformAdmin: row.isPlatformAdmin,
  };
}

export async function revokeSession(
  db: Db,
  params: { sessionId: string; userId: string; reason: string },
): Promise<boolean> {
  const result = await db
    .updateTable('sessions')
    .set({ revoked_at: sql`now()`, revoked_reason: params.reason })
    .where('id', '=', params.sessionId)
    .where('user_id', '=', params.userId) // a user can only revoke their own sessions
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

export async function revokeAllSessions(
  db: Db,
  params: { userId: string; reason: string; exceptSessionId?: string },
): Promise<number> {
  let query = db
    .updateTable('sessions')
    .set({ revoked_at: sql`now()`, revoked_reason: params.reason })
    .where('user_id', '=', params.userId)
    .where('revoked_at', 'is', null);
  if (params.exceptSessionId) query = query.where('id', '!=', params.exceptSessionId);
  const result = await query.executeTakeFirst();
  return Number(result.numUpdatedRows);
}

export async function listActiveSessions(db: Db, userId: string) {
  return db
    .selectFrom('sessions')
    .select([
      'id',
      'created_at',
      'last_seen_at',
      'expires_at',
      'ip_address',
      'user_agent',
      'mfa_verified',
    ])
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .where('idle_expires_at', '>', sql<Date>`now()`)
    .orderBy('last_seen_at', 'desc')
    .limit(100)
    .execute();
}

/**
 * CSRF token bound to the session (HMAC of the session id). Required as the
 * `X-CSRF-Token` header on state-changing requests authenticated by cookie.
 * It is not secret from the session holder; its job is to be unknowable to
 * other origins.
 */
export function csrfTokenFor(csrfKey: Buffer, sessionId: string): string {
  return hmacSha256Hex(csrfKey, `csrf:${sessionId}`);
}

export function verifyCsrfToken(
  csrfKey: Buffer,
  sessionId: string,
  provided: string | undefined,
): boolean {
  return typeof provided === 'string' && safeEqual(provided, csrfTokenFor(csrfKey, sessionId));
}
