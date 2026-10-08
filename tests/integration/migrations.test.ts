import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASSETS } from '@actualpay/shared';
import { createMigrator, migrateToLatest, type Database, type Db } from '@actualpay/database';
import { createOrganization, createTestDb, resetDatabase } from './helpers';

let db: Db;

beforeAll(async () => {
  db = createTestDb();
  await resetDatabase(db);
});
afterAll(async () => {
  await db.destroy();
});

describe('migrations', () => {
  it('applies every migration and is idempotent on re-run', async () => {
    const before = await createMigrator(db).getMigrations();
    expect(before.every((m) => m.executedAt)).toBe(true);
    const again = await migrateToLatest(db);
    expect(again.results ?? []).toHaveLength(0);
  });

  it('syncs the asset registry with protocol decimals', async () => {
    const rows = await db.selectFrom('assets').selectAll().orderBy('id').execute();
    expect(rows.map((r) => r.id).sort()).toEqual(Object.keys(ASSETS).sort());
    for (const row of rows)
      expect(row.decimals).toBe(ASSETS[row.id as keyof typeof ASSETS].decimals);
  });

  it('freezes asset protocol fields and forbids deleting assets', async () => {
    await expect(
      db.updateTable('assets').set({ decimals: 2 }).where('id', '=', 'btc').execute(),
    ).rejects.toThrow(/immutable/);
    await expect(db.deleteFrom('assets').where('id', '=', 'btc').execute()).rejects.toThrow(
      /append-only/,
    );
  });

  it('forbids deleting organizations', async () => {
    const orgId = await createOrganization(db);
    await expect(db.deleteFrom('organizations').where('id', '=', orgId).execute()).rejects.toThrow(
      /append-only/,
    );
  });

  it('keeps audit_log append-only', async () => {
    await db
      .insertInto('audit_log')
      .values({
        actor_type: 'system',
        action: 'system.test.ran',
        metadata: JSON.stringify({ ok: true }),
      })
      .execute();
    await expect(
      db.updateTable('audit_log').set({ action: 'system.tampered.x' }).execute(),
    ).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('audit_log').execute()).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE audit_log`.execute(db)).rejects.toThrow(/append-only/);
  });

  it('validates audit action names and requires actor ids for non-system actors', async () => {
    await expect(
      db.insertInto('audit_log').values({ actor_type: 'system', action: 'NotDotted' }).execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insertInto('audit_log')
        .values({ actor_type: 'user', action: 'user.login.succeeded' })
        .execute(),
    ).rejects.toThrow();
  });

  it('enforces idempotency key uniqueness per organization and scope', async () => {
    const orgId = await createOrganization(db);
    const row = {
      organization_id: orgId,
      scope: 'POST /v1/withdrawals',
      key: 'abc-123',
      request_hash: 'a'.repeat(64),
      expires_at: new Date(Date.now() + 86_400_000),
    };
    await db.insertInto('idempotency_keys').values(row).execute();
    await expect(db.insertInto('idempotency_keys').values(row).execute()).rejects.toThrow(
      /duplicate key/,
    );
    await db
      .insertInto('idempotency_keys')
      .values({ ...row, scope: 'POST /v1/invoices' })
      .execute();
  });
});

/**
 * Schema drift guard. TypeScript forces `expected` to list exactly the
 * columns declared in the Kysely `Database` type; this test forces the real
 * database to have exactly those columns. Together they keep schema.ts and
 * the migrations in sync.
 */
type ColumnsOf<T> = { [K in keyof T]-?: true };
const expected: { [Table in keyof Database]: ColumnsOf<Database[Table]> } = {
  organizations: {
    id: true,
    slug: true,
    name: true,
    status: true,
    created_at: true,
    updated_at: true,
  },
  assets: {
    id: true,
    chain: true,
    symbol: true,
    kind: true,
    decimals: true,
    fee_asset_id: true,
    created_at: true,
  },
  ledger_accounts: {
    id: true,
    organization_id: true,
    asset_id: true,
    type: true,
    normal_side: true,
    allow_negative: true,
    balance: true,
    created_at: true,
    updated_at: true,
  },
  ledger_journals: {
    id: true,
    external_ref: true,
    kind: true,
    organization_id: true,
    content_hash: true,
    reverses_journal_id: true,
    description: true,
    metadata: true,
    created_at: true,
  },
  ledger_entries: {
    id: true,
    journal_id: true,
    account_id: true,
    asset_id: true,
    direction: true,
    amount: true,
    created_at: true,
  },
  audit_log: {
    id: true,
    occurred_at: true,
    actor_type: true,
    actor_id: true,
    organization_id: true,
    action: true,
    target_type: true,
    target_id: true,
    request_id: true,
    ip_address: true,
    user_agent: true,
    metadata: true,
  },
  users: {
    id: true,
    email: true,
    email_verified_at: true,
    password_hash: true,
    display_name: true,
    status: true,
    is_platform_admin: true,
    failed_login_count: true,
    locked_until: true,
    password_changed_at: true,
    created_at: true,
    updated_at: true,
  },
  organization_members: {
    organization_id: true,
    user_id: true,
    role: true,
    created_at: true,
    updated_at: true,
  },
  sessions: {
    id: true,
    user_id: true,
    token_hash: true,
    mfa_verified: true,
    created_at: true,
    last_seen_at: true,
    idle_expires_at: true,
    expires_at: true,
    revoked_at: true,
    revoked_reason: true,
    ip_address: true,
    user_agent: true,
  },
  auth_tokens: {
    id: true,
    user_id: true,
    purpose: true,
    token_hash: true,
    expires_at: true,
    consumed_at: true,
    attempts: true,
    created_at: true,
  },
  totp_credentials: {
    user_id: true,
    secret_ciphertext: true,
    confirmed_at: true,
    last_used_step: true,
    created_at: true,
  },
  recovery_codes: { id: true, user_id: true, code_hash: true, used_at: true, created_at: true },
  organization_invitations: {
    id: true,
    organization_id: true,
    email: true,
    role: true,
    token_hash: true,
    invited_by: true,
    expires_at: true,
    accepted_at: true,
    accepted_by: true,
    revoked_at: true,
    created_at: true,
  },
  api_keys: {
    id: true,
    organization_id: true,
    public_id: true,
    secret_hash: true,
    name: true,
    scopes: true,
    created_by: true,
    created_at: true,
    expires_at: true,
    revoked_at: true,
    revoked_by: true,
    last_used_at: true,
    last_used_ip: true,
    rotated_from_id: true,
  },
  idempotency_keys: {
    id: true,
    organization_id: true,
    scope: true,
    key: true,
    request_hash: true,
    state: true,
    response_status: true,
    response_body: true,
    locked_until: true,
    created_at: true,
    expires_at: true,
  },
};

describe('schema drift', () => {
  it('database columns match the Kysely types exactly', async () => {
    const rows = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name NOT LIKE 'kysely_%'
    `.execute(db);
    const actual: Record<string, string[]> = {};
    for (const row of rows.rows) (actual[row.table_name] ??= []).push(row.column_name);
    const wanted = Object.fromEntries(
      Object.entries(expected).map(([table, cols]) => [table, Object.keys(cols).sort()]),
    );
    const got = Object.fromEntries(
      Object.entries(actual).map(([table, cols]) => [table, cols.sort()]),
    );
    expect(got).toEqual(wanted);
  });
});
