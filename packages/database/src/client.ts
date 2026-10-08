/**
 * PostgreSQL connection management.
 */
import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './schema';

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

export interface DbOptions {
  url: string;
  poolMax?: number;
  ssl?: boolean;
  applicationName?: string;
}

export function createDb(options: DbOptions): Db {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.poolMax ?? 10,
    application_name: options.applicationName ?? 'actualpay',
    // Verify server certificates whenever TLS is on; never rejectUnauthorized:false.
    ...(options.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    // A transaction left open (e.g. a crashed request mid-withdrawal) holds row
    // locks on ledger accounts; cap how long that can last.
    options: '-c idle_in_transaction_session_timeout=60000 -c lock_timeout=10000',
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** PostgreSQL SQLSTATE codes we react to explicitly. */
export const PG_ERRORS = {
  UNIQUE_VIOLATION: '23505',
  CHECK_VIOLATION: '23514',
  FOREIGN_KEY_VIOLATION: '23503',
  RESTRICT_VIOLATION: '23001',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
} as const;

export interface PgErrorLike {
  code: string;
  constraint?: string;
  message: string;
}

export function asPgError(error: unknown): PgErrorLike | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error as PgErrorLike;
  }
  return undefined;
}

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

/**
 * Run `fn` in a transaction, retrying on serialization failures and
 * deadlocks. `fn` must be safe to re-run from the top: do not perform
 * non-transactional side effects (HTTP calls, broadcasts) inside it.
 */
export async function inTransaction<T>(
  db: Db,
  fn: (tx: Tx) => Promise<T>,
  options: { isolation?: IsolationLevel; maxAttempts?: number } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await db
        .transaction()
        .setIsolationLevel(options.isolation ?? 'read committed')
        .execute(fn);
    } catch (error) {
      const code = asPgError(error)?.code;
      const retryable =
        code === PG_ERRORS.SERIALIZATION_FAILURE || code === PG_ERRORS.DEADLOCK_DETECTED;
      if (!retryable || attempt >= maxAttempts) throw error;
      // Small jittered backoff so competing transactions don't collide again.
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt + Math.random() * 20));
    }
  }
}
