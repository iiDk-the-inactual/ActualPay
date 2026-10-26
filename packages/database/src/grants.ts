/**
 * Least-privilege access for the running application.
 *
 * Two roles, never one:
 *   owner  owns the tables and runs migrations; used only by the one-shot migrate job.
 *   app    what the API, worker and signer connect as. It can read and write rows but
 *          cannot change the schema, truncate tables, disable triggers or drop
 *          anything. With the append-only triggers, stolen application credentials
 *          cannot rewrite history through SQL.
 *
 * `node dist/db.mjs grant <role>` (or DATABASE_APP_ROLE on `migrate`) applies these,
 * as the owner, and is safe to repeat. Default privileges cover tables added by
 * later migrations run by the same owner.
 */
import { sql } from 'kysely';
import type { Db } from './client';

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** The only tables the application ever deletes from; everything else is append-only or soft-deleted. */
export const APP_DELETABLE_TABLES = ['organization_members', 'totp_credentials'] as const;

export function appRoleGrantStatements(role: string): string[] {
  if (!ROLE_NAME.test(role)) throw new Error(`Invalid role name: ${role}`);
  return [
    'REVOKE ALL ON SCHEMA public FROM PUBLIC',
    `GRANT USAGE ON SCHEMA public TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${role}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
    `GRANT DELETE ON ${APP_DELETABLE_TABLES.join(', ')} TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
  ];
}

export async function grantAppRole(db: Db, role: string): Promise<void> {
  const exists = await sql<{
    n: string;
  }>`SELECT count(*) AS n FROM pg_roles WHERE rolname = ${role}`.execute(db);
  if (Number(exists.rows[0]?.n ?? 0) === 0)
    throw new Error(`Role "${role}" does not exist. Create it first (see docs/deployment.md).`);
  for (const statement of appRoleGrantStatements(role)) await sql.raw(statement).execute(db);
}
