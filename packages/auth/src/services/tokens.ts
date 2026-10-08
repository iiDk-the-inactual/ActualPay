/**
 * Single-use, expiring tokens for email verification, password reset and
 * MFA login challenges. Only SHA-256 hashes are stored.
 */
import { sql } from 'kysely';
import type { AuthTokenPurpose, Db } from '@actualpay/database';
import { randomToken, sha256Hex } from '../crypto';

export const TOKEN_TTL_MINUTES: Readonly<Record<AuthTokenPurpose, number>> = {
  email_verification: 24 * 60,
  password_reset: 30,
  mfa_challenge: 5,
};

/** Maximum wrong second-factor codes per MFA challenge before it is burned. */
export const MFA_CHALLENGE_MAX_ATTEMPTS = 5;

/**
 * Issue a token, invalidating older unused tokens of the same purpose so
 * only the newest email link works.
 */
export async function issueAuthToken(
  db: Db,
  userId: string,
  purpose: AuthTokenPurpose,
): Promise<string> {
  const token = randomToken(32);
  await db
    .updateTable('auth_tokens')
    .set({ consumed_at: sql`now()` })
    .where('user_id', '=', userId)
    .where('purpose', '=', purpose)
    .where('consumed_at', 'is', null)
    .execute();
  await db
    .insertInto('auth_tokens')
    .values({
      user_id: userId,
      purpose,
      token_hash: sha256Hex(token),
      expires_at: sql<Date>`now() + make_interval(mins => ${TOKEN_TTL_MINUTES[purpose]})`,
    })
    .execute();
  return token;
}

/**
 * Atomically consume a token. Two concurrent requests with the same token
 * cannot both succeed: the UPDATE … WHERE consumed_at IS NULL serialises them.
 */
export async function consumeAuthToken(
  db: Db,
  purpose: AuthTokenPurpose,
  token: string,
): Promise<string | null> {
  if (token.length < 20 || token.length > 100) return null;
  const row = await db
    .updateTable('auth_tokens')
    .set({ consumed_at: sql`now()` })
    .where('token_hash', '=', sha256Hex(token))
    .where('purpose', '=', purpose)
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .returning('user_id')
    .executeTakeFirst();
  return row?.user_id ?? null;
}

/** Look up (without consuming) a live MFA challenge, counting the attempt. */
export async function touchMfaChallenge(
  db: Db,
  token: string,
): Promise<{ id: string; userId: string } | null> {
  if (token.length < 20 || token.length > 100) return null;
  const row = await db
    .updateTable('auth_tokens')
    .set({ attempts: sql`attempts + 1` })
    .where('token_hash', '=', sha256Hex(token))
    .where('purpose', '=', 'mfa_challenge')
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .where('attempts', '<', MFA_CHALLENGE_MAX_ATTEMPTS)
    .returning(['id', 'user_id'])
    .executeTakeFirst();
  return row ? { id: row.id, userId: row.user_id } : null;
}

export async function consumeTokenById(db: Db, id: string): Promise<boolean> {
  const result = await db
    .updateTable('auth_tokens')
    .set({ consumed_at: sql`now()` })
    .where('id', '=', id)
    .where('consumed_at', 'is', null)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}
