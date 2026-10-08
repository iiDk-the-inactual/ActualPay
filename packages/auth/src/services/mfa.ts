/**
 * TOTP two-factor authentication with single-use recovery codes.
 *
 * Enrollment is two-step (start → confirm with a valid code) so a user can
 * never lock themselves out with a seed their app did not actually store.
 * All second-factor verification locks the credential row, so the same code
 * cannot be accepted twice by concurrent requests.
 */
import { sql } from 'kysely';
import { AppError } from '@actualpay/shared';
import { inTransaction, type Db } from '@actualpay/database';
import { recordAudit, type RequestMeta } from '@actualpay/audit';
import { securityNoticeEmail, sendSafely } from '@actualpay/email';
import { verifyPassword } from '../passwords';
import { generateRecoveryCodes, hashRecoveryCode } from '../recovery-codes';
import { generateTotpSecret, totpUri, verifyTotp } from '../totp';
import type { AuthDeps } from './deps';
import { revokeAllSessions } from './sessions';

const totpContext = (userId: string) => `totp:${userId}`;

export async function startTotpEnrollment(
  deps: AuthDeps,
  userId: string,
): Promise<{ secret: string; otpauthUri: string }> {
  const user = await deps.db
    .selectFrom('users')
    .select(['email'])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  const existing = await deps.db
    .selectFrom('totp_credentials')
    .select(['confirmed_at'])
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (existing?.confirmed_at)
    throw AppError.conflict('Two-factor authentication is already enabled.');

  const secret = generateTotpSecret();
  const ciphertext = deps.totpBox.seal(secret, totpContext(userId));
  await deps.db
    .insertInto('totp_credentials')
    .values({ user_id: userId, secret_ciphertext: ciphertext })
    .onConflict((oc) =>
      oc
        .column('user_id')
        .doUpdateSet({ secret_ciphertext: ciphertext, last_used_step: null })
        .where('totp_credentials.confirmed_at', 'is', null),
    )
    .execute();
  return { secret, otpauthUri: totpUri({ secret, issuer: deps.appName, accountName: user.email }) };
}

/** Confirm enrollment; returns recovery codes, shown to the user exactly once. */
export async function confirmTotpEnrollment(
  deps: AuthDeps,
  params: { userId: string; currentSessionId: string; code: string },
  meta: RequestMeta,
): Promise<string[]> {
  const codes = generateRecoveryCodes();
  const email = await inTransaction(deps.db, async (tx) => {
    const cred = await tx
      .selectFrom('totp_credentials')
      .selectAll()
      .where('user_id', '=', params.userId)
      .forUpdate()
      .executeTakeFirst();
    if (!cred) throw AppError.validation('Start two-factor enrollment first.');
    if (cred.confirmed_at) throw AppError.conflict('Two-factor authentication is already enabled.');
    const secret = deps.totpBox.open(cred.secret_ciphertext, totpContext(params.userId));
    const step = verifyTotp({ secret, code: params.code, lastUsedStep: null });
    if (step === null)
      throw AppError.validation(
        'The code is incorrect. Check your authenticator app and device clock.',
      );

    await tx
      .updateTable('totp_credentials')
      .set({ confirmed_at: sql`now()`, last_used_step: step.toString() })
      .where('user_id', '=', params.userId)
      .execute();
    await replaceRecoveryCodes(tx, params.userId, codes);
    // The current session just proved both factors; others are signed out.
    await tx
      .updateTable('sessions')
      .set({ mfa_verified: true })
      .where('id', '=', params.currentSessionId)
      .execute();
    await revokeAllSessions(tx, {
      userId: params.userId,
      reason: 'mfa_enabled',
      exceptSessionId: params.currentSessionId,
    });
    await recordAudit(tx, {
      actor: { type: 'user', id: params.userId },
      action: 'user.mfa.enabled',
      target: { type: 'user', id: params.userId },
      meta,
    });
    return (
      await tx
        .selectFrom('users')
        .select('email')
        .where('id', '=', params.userId)
        .executeTakeFirstOrThrow()
    ).email;
  });
  await sendSafely(
    deps.mailer,
    securityNoticeEmail({
      to: email,
      appName: deps.appName,
      event: 'Two-factor authentication was enabled.',
    }),
    deps.logger,
  );
  return codes;
}

async function replaceRecoveryCodes(
  db: Db,
  userId: string,
  codes: readonly string[],
): Promise<void> {
  await db
    .updateTable('recovery_codes')
    .set({ used_at: sql`now()` })
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .execute();
  await db
    .insertInto('recovery_codes')
    .values(codes.map((code) => ({ user_id: userId, code_hash: hashRecoveryCode(code) })))
    .execute();
}

/**
 * Verify a TOTP code or a recovery code for a user with confirmed MFA.
 * Must be called inside a transaction (the credential row is locked).
 */
export async function verifySecondFactor(
  deps: AuthDeps,
  tx: Db,
  params: { userId: string; code: string },
): Promise<'totp' | 'recovery_code' | null> {
  const cred = await tx
    .selectFrom('totp_credentials')
    .selectAll()
    .where('user_id', '=', params.userId)
    .forUpdate()
    .executeTakeFirst();
  if (!cred?.confirmed_at) return null;

  const trimmed = params.code.trim();
  if (/^[0-9\s]{6,8}$/.test(trimmed)) {
    const secret = deps.totpBox.open(cred.secret_ciphertext, totpContext(params.userId));
    const step = verifyTotp({
      secret,
      code: trimmed,
      lastUsedStep: cred.last_used_step === null ? null : BigInt(cred.last_used_step),
    });
    if (step === null) return null;
    await tx
      .updateTable('totp_credentials')
      .set({ last_used_step: step.toString() })
      .where('user_id', '=', params.userId)
      .execute();
    return 'totp';
  }

  const used = await tx
    .updateTable('recovery_codes')
    .set({ used_at: sql`now()` })
    .where('user_id', '=', params.userId)
    .where('code_hash', '=', hashRecoveryCode(trimmed))
    .where('used_at', 'is', null)
    .executeTakeFirst();
  return used.numUpdatedRows === 1n ? 'recovery_code' : null;
}

/** Disabling MFA requires the password *and* a valid second factor. */
export async function disableTotp(
  deps: AuthDeps,
  params: { userId: string; currentSessionId: string; password: string; code: string },
  meta: RequestMeta,
): Promise<void> {
  const user = await deps.db
    .selectFrom('users')
    .select(['email', 'password_hash'])
    .where('id', '=', params.userId)
    .executeTakeFirstOrThrow();
  if (!(await verifyPassword(user.password_hash, params.password)))
    throw new AppError('UNAUTHENTICATED', 'The password is incorrect.');
  await inTransaction(deps.db, async (tx) => {
    const factor = await verifySecondFactor(deps, tx, { userId: params.userId, code: params.code });
    if (!factor) throw new AppError('UNAUTHENTICATED', 'The two-factor code is incorrect.');
    await tx.deleteFrom('totp_credentials').where('user_id', '=', params.userId).execute();
    await tx
      .updateTable('recovery_codes')
      .set({ used_at: sql`now()` })
      .where('user_id', '=', params.userId)
      .where('used_at', 'is', null)
      .execute();
    await revokeAllSessions(tx, {
      userId: params.userId,
      reason: 'mfa_disabled',
      exceptSessionId: params.currentSessionId,
    });
    await recordAudit(tx, {
      actor: { type: 'user', id: params.userId },
      action: 'user.mfa.disabled',
      target: { type: 'user', id: params.userId },
      meta,
    });
  });
  await sendSafely(
    deps.mailer,
    securityNoticeEmail({
      to: user.email,
      appName: deps.appName,
      event: 'Two-factor authentication was disabled.',
    }),
    deps.logger,
  );
}

export async function regenerateRecoveryCodes(
  deps: AuthDeps,
  params: { userId: string; code: string },
  meta: RequestMeta,
): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await inTransaction(deps.db, async (tx) => {
    const factor = await verifySecondFactor(deps, tx, params);
    if (factor !== 'totp')
      throw new AppError('UNAUTHENTICATED', 'A current authenticator code is required.');
    await replaceRecoveryCodes(tx, params.userId, codes);
    await recordAudit(tx, {
      actor: { type: 'user', id: params.userId },
      action: 'user.mfa.recovery_codes_regenerated',
      target: { type: 'user', id: params.userId },
      meta,
    });
  });
  return codes;
}

export async function remainingRecoveryCodes(db: Db, userId: string): Promise<number> {
  const row = await db
    .selectFrom('recovery_codes')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}
