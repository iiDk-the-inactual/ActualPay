/**
 * Account lifecycle: registration, email verification, password login with
 * lockout, password reset and change.
 *
 * Enumeration resistance: registration and reset requests return the same
 * response whether or not the email exists, and login spends the same Argon2
 * work for unknown users. The *email* is what differs, and only the mailbox
 * owner can see it.
 */
import { sql } from 'kysely';
import { AppError } from '@actualpay/shared';
import { inTransaction } from '@actualpay/database';
import { recordAudit, type RequestMeta } from '@actualpay/audit';
import {
  existingAccountEmail,
  passwordResetEmail,
  securityNoticeEmail,
  sendSafely,
  verificationEmail,
} from '@actualpay/email';
import { normalizeEmail } from '../email-address';
import {
  assertPasswordAcceptable,
  getDummyHash,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../passwords';
import { appLink, type AuthDeps } from './deps';
import { consumeAuthToken, issueAuthToken } from './tokens';
import { revokeAllSessions } from './sessions';

export interface PublicUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly emailVerified: boolean;
  readonly isPlatformAdmin: boolean;
}

export async function registerUser(
  deps: AuthDeps,
  input: { email: string; password: string; displayName: string },
  meta: RequestMeta,
): Promise<void> {
  const email = normalizeEmail(input.email);
  assertPasswordAcceptable(input.password, { email });
  const displayName = input.displayName.trim();
  if (displayName.length < 1 || displayName.length > 100)
    throw AppError.validation('Display name must be 1–100 characters.');

  // Hash before touching the database so existing and new emails take the same time.
  const passwordHash = await hashPassword(input.password);

  const outcome = await inTransaction(deps.db, async (tx) => {
    const inserted = await tx
      .insertInto('users')
      .values({ email, password_hash: passwordHash, display_name: displayName })
      .onConflict((oc) => oc.column('email').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) return { kind: 'exists' as const };
    await recordAudit(tx, {
      actor: { type: 'user', id: inserted.id },
      action: 'user.registered',
      target: { type: 'user', id: inserted.id },
      meta,
    });
    const token = await issueAuthToken(tx, inserted.id, 'email_verification');
    return { kind: 'created' as const, token };
  });

  if (outcome.kind === 'created') {
    await sendSafely(
      deps.mailer,
      verificationEmail({
        to: email,
        appName: deps.appName,
        link: appLink(deps, '/verify-email', outcome.token),
      }),
      deps.logger,
    );
  } else {
    const resetLink = new URL('/forgot-password', deps.publicBaseUrl).toString();
    await sendSafely(
      deps.mailer,
      existingAccountEmail({ to: email, appName: deps.appName, resetLink }),
      deps.logger,
    );
  }
}

export async function resendVerification(deps: AuthDeps, rawEmail: string): Promise<void> {
  let email: string;
  try {
    email = normalizeEmail(rawEmail);
  } catch {
    return; // Same silent success as for unknown emails.
  }
  const user = await deps.db
    .selectFrom('users')
    .select(['id', 'email_verified_at'])
    .where('email', '=', email)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!user || user.email_verified_at !== null) return;
  const token = await issueAuthToken(deps.db, user.id, 'email_verification');
  await sendSafely(
    deps.mailer,
    verificationEmail({
      to: email,
      appName: deps.appName,
      link: appLink(deps, '/verify-email', token),
    }),
    deps.logger,
  );
}

export async function verifyEmail(deps: AuthDeps, token: string, meta: RequestMeta): Promise<void> {
  await inTransaction(deps.db, async (tx) => {
    const userId = await consumeAuthToken(tx, 'email_verification', token);
    if (!userId) throw AppError.validation('This verification link is invalid or has expired.');
    await tx
      .updateTable('users')
      .set({ email_verified_at: sql`COALESCE(email_verified_at, now())` })
      .where('id', '=', userId)
      .execute();
    await recordAudit(tx, {
      actor: { type: 'user', id: userId },
      action: 'user.email.verified',
      target: { type: 'user', id: userId },
      meta,
    });
  });
}

export type PasswordLoginResult =
  | { readonly kind: 'ok'; readonly userId: string; readonly mfaEnabled: boolean }
  | { readonly kind: 'invalid' };

/**
 * Check email + password with account lockout.
 *
 * Every failure mode (unknown email, wrong password, locked, disabled,
 * unverified) returns the same `invalid` result so the API can respond
 * identically. Unverified accounts are the one exception the caller may
 * surface, because it can only be reached with the correct password.
 */
export async function authenticatePassword(
  deps: AuthDeps,
  input: { email: string; password: string },
  meta: RequestMeta,
): Promise<PasswordLoginResult | { readonly kind: 'unverified' }> {
  let email: string;
  try {
    email = normalizeEmail(input.email);
  } catch {
    await verifyPassword(await getDummyHash(), input.password);
    return { kind: 'invalid' };
  }

  const user = await deps.db
    .selectFrom('users as u')
    .leftJoin('totp_credentials as t', 't.user_id', 'u.id')
    .select([
      'u.id',
      'u.password_hash',
      'u.status',
      'u.locked_until',
      'u.email_verified_at',
      't.confirmed_at as mfaConfirmedAt',
    ])
    .where('u.email', '=', email)
    .executeTakeFirst();

  if (!user) {
    await verifyPassword(await getDummyHash(), input.password);
    return { kind: 'invalid' };
  }

  const passwordOk = await verifyPassword(user.password_hash, input.password);
  const locked = user.locked_until !== null && user.locked_until.getTime() > Date.now();

  if (!passwordOk || locked || user.status !== 'active') {
    if (!passwordOk) {
      const { maxFailures, lockMinutes } = deps.lockoutPolicy;
      // Atomic increment; lock once the threshold is crossed. A successful
      // login resets the counter.
      await inTransaction(deps.db, async (tx) => {
        const updated = await tx
          .updateTable('users')
          .set({
            failed_login_count: sql`failed_login_count + 1`,
            locked_until: sql`CASE WHEN failed_login_count + 1 >= ${maxFailures} THEN now() + make_interval(mins => ${lockMinutes}) ELSE locked_until END`,
          })
          .where('id', '=', user.id)
          .returning(['failed_login_count', 'locked_until'])
          .executeTakeFirstOrThrow();
        await recordAudit(tx, {
          actor: { type: 'user', id: user.id },
          action: 'user.login.failed',
          target: { type: 'user', id: user.id },
          meta,
          metadata: {
            failures: updated.failed_login_count,
            locked: updated.locked_until !== null && updated.locked_until.getTime() > Date.now(),
          },
        });
      });
    }
    return { kind: 'invalid' };
  }

  if (user.email_verified_at === null) return { kind: 'unverified' };

  await deps.db
    .updateTable('users')
    .set({ failed_login_count: 0, locked_until: null })
    .where('id', '=', user.id)
    .execute();
  if (needsRehash(user.password_hash)) {
    await deps.db
      .updateTable('users')
      .set({ password_hash: await hashPassword(input.password) })
      .where('id', '=', user.id)
      .execute();
  }
  return { kind: 'ok', userId: user.id, mfaEnabled: user.mfaConfirmedAt !== null };
}

export async function requestPasswordReset(
  deps: AuthDeps,
  rawEmail: string,
  meta: RequestMeta,
): Promise<void> {
  let email: string;
  try {
    email = normalizeEmail(rawEmail);
  } catch {
    return;
  }
  const user = await deps.db
    .selectFrom('users')
    .select(['id'])
    .where('email', '=', email)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!user) return;
  const token = await issueAuthToken(deps.db, user.id, 'password_reset');
  await recordAudit(deps.db, {
    actor: { type: 'user', id: user.id },
    action: 'user.password_reset.requested',
    target: { type: 'user', id: user.id },
    meta,
  });
  await sendSafely(
    deps.mailer,
    passwordResetEmail({
      to: email,
      appName: deps.appName,
      link: appLink(deps, '/reset-password', token),
    }),
    deps.logger,
  );
}

/**
 * Complete a reset. Also verifies the email (the user proved mailbox
 * control), clears lockout and revokes every session.
 */
export async function resetPassword(
  deps: AuthDeps,
  input: { token: string; newPassword: string },
  meta: RequestMeta,
): Promise<void> {
  if (input.newPassword.length < 1) throw AppError.validation('A new password is required.');
  const passwordHash = await hashPassword(input.newPassword);
  const email = await inTransaction(deps.db, async (tx) => {
    const userId = await consumeAuthToken(tx, 'password_reset', input.token);
    if (!userId) throw AppError.validation('This reset link is invalid or has expired.');
    const user = await tx
      .selectFrom('users')
      .select(['email'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    assertPasswordAcceptable(input.newPassword, { email: user.email });
    await tx
      .updateTable('users')
      .set({
        password_hash: passwordHash,
        password_changed_at: sql`now()`,
        failed_login_count: 0,
        locked_until: null,
        email_verified_at: sql`COALESCE(email_verified_at, now())`,
      })
      .where('id', '=', userId)
      .execute();
    await revokeAllSessions(tx, { userId, reason: 'password_reset' });
    await recordAudit(tx, {
      actor: { type: 'user', id: userId },
      action: 'user.password_reset.completed',
      target: { type: 'user', id: userId },
      meta,
    });
    return user.email;
  });
  await sendSafely(
    deps.mailer,
    securityNoticeEmail({
      to: email,
      appName: deps.appName,
      event: 'Your password was reset and all sessions were signed out.',
    }),
    deps.logger,
  );
}

export async function changePassword(
  deps: AuthDeps,
  input: { userId: string; currentSessionId: string; currentPassword: string; newPassword: string },
  meta: RequestMeta,
): Promise<void> {
  const user = await deps.db
    .selectFrom('users')
    .select(['email', 'password_hash'])
    .where('id', '=', input.userId)
    .executeTakeFirstOrThrow();
  if (!(await verifyPassword(user.password_hash, input.currentPassword))) {
    throw new AppError('UNAUTHENTICATED', 'The current password is incorrect.');
  }
  assertPasswordAcceptable(input.newPassword, { email: user.email });
  const passwordHash = await hashPassword(input.newPassword);
  await inTransaction(deps.db, async (tx) => {
    await tx
      .updateTable('users')
      .set({ password_hash: passwordHash, password_changed_at: sql`now()` })
      .where('id', '=', input.userId)
      .execute();
    await revokeAllSessions(tx, {
      userId: input.userId,
      reason: 'password_changed',
      exceptSessionId: input.currentSessionId,
    });
    await recordAudit(tx, {
      actor: { type: 'user', id: input.userId },
      action: 'user.password.changed',
      target: { type: 'user', id: input.userId },
      meta,
    });
  });
  await sendSafely(
    deps.mailer,
    securityNoticeEmail({
      to: user.email,
      appName: deps.appName,
      event: 'Your password was changed. Other sessions were signed out.',
    }),
    deps.logger,
  );
}

export async function getPublicUser(deps: AuthDeps, userId: string): Promise<PublicUser> {
  const row = await deps.db
    .selectFrom('users')
    .select(['id', 'email', 'display_name', 'email_verified_at', 'is_platform_admin'])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    emailVerified: row.email_verified_at !== null,
    isPlatformAdmin: row.is_platform_admin,
  };
}

/**
 * Bootstrap path for the CLI (`admin:create`): creates a verified platform
 * administrator without email. Refuses to overwrite an existing account.
 */
export async function createPlatformAdmin(
  deps: Pick<AuthDeps, 'db'>,
  input: { email: string; password: string; displayName: string },
): Promise<string> {
  const email = normalizeEmail(input.email);
  assertPasswordAcceptable(input.password, { email });
  const passwordHash = await hashPassword(input.password);
  return inTransaction(deps.db, async (tx) => {
    const row = await tx
      .insertInto('users')
      .values({
        email,
        password_hash: passwordHash,
        display_name: input.displayName.trim() || 'Administrator',
        is_platform_admin: true,
        email_verified_at: sql`now()`,
      })
      .onConflict((oc) => oc.column('email').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!row) throw AppError.conflict('A user with this email already exists.');
    await recordAudit(tx, {
      actor: { type: 'system' },
      action: 'admin.platform_admin.created',
      target: { type: 'user', id: row.id },
    });
    return row.id;
  });
}
