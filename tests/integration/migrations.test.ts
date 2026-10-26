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
  wallets: {
    id: true,
    organization_id: true,
    chain: true,
    network: true,
    label: true,
    account_xpub: true,
    key_id: true,
    xrpl_address: true,
    next_index: true,
    watched_through: true,
    status: true,
    verified_at: true,
    verified_by: true,
    created_by: true,
    archived_at: true,
    created_at: true,
    updated_at: true,
  },
  deposit_addresses: {
    id: true,
    wallet_id: true,
    organization_id: true,
    chain: true,
    network: true,
    address: true,
    derivation_index: true,
    destination_tag: true,
    reference_type: true,
    reference_id: true,
    created_at: true,
  },
  payment_links: {
    id: true,
    public_id: true,
    organization_id: true,
    asset_id: true,
    amount: true,
    title: true,
    description: true,
    invoice_ttl_minutes: true,
    max_open_invoices: true,
    active: true,
    created_by: true,
    created_at: true,
    updated_at: true,
  },
  invoices: {
    id: true,
    public_id: true,
    organization_id: true,
    wallet_id: true,
    deposit_address_id: true,
    payment_link_id: true,
    asset_id: true,
    amount_due: true,
    amount_confirmed: true,
    amount_pending: true,
    status: true,
    external_id: true,
    description: true,
    metadata: true,
    expires_at: true,
    cancelled_at: true,
    paid_at: true,
    paid_late: true,
    created_by_type: true,
    created_by_id: true,
    created_at: true,
    updated_at: true,
  },
  payments: {
    id: true,
    organization_id: true,
    invoice_id: true,
    deposit_address_id: true,
    ref: true,
    asset_id: true,
    tx_hash: true,
    amount: true,
    counts_toward_invoice: true,
    status: true,
    epoch: true,
    block_height: true,
    block_hash: true,
    confirmations: true,
    deposit_journal_id: true,
    reversal_journal_id: true,
    detected_at: true,
    confirmed_at: true,
    reversed_at: true,
    last_checked_at: true,
    created_at: true,
    updated_at: true,
  },
  domain_events: {
    id: true,
    organization_id: true,
    type: true,
    subject_type: true,
    subject_id: true,
    payload: true,
    occurred_at: true,
  },
  chain_cursors: {
    chain: true,
    network: true,
    cursor: true,
    initialised_at: true,
    scanned_at: true,
    tip_height: true,
    final_height: true,
    synced: true,
    last_error: true,
    last_error_at: true,
    updated_at: true,
  },
  job_leases: {
    name: true,
    locked_by: true,
    locked_until: true,
    last_started_at: true,
    last_finished_at: true,
    last_error: true,
    last_error_at: true,
    run_count: true,
  },
  reconciliation_issues: {
    id: true,
    kind: true,
    severity: true,
    status: true,
    subject_type: true,
    subject_id: true,
    organization_id: true,
    summary: true,
    details: true,
    occurrences: true,
    first_seen_at: true,
    last_seen_at: true,
    resolved_at: true,
    resolved_by: true,
    resolution_note: true,
  },
  webhook_endpoints: {
    id: true,
    organization_id: true,
    url: true,
    description: true,
    event_types: true,
    secret_ciphertext: true,
    previous_secret_ciphertext: true,
    previous_secret_expires_at: true,
    status: true,
    disabled_reason: true,
    consecutive_failures: true,
    created_by_type: true,
    created_by_id: true,
    created_at: true,
    updated_at: true,
  },
  notification_preferences: {
    user_id: true,
    organization_id: true,
    kind: true,
    enabled: true,
    updated_at: true,
  },
  notification_forwards: {
    id: true,
    organization_id: true,
    email: true,
    kinds: true,
    status: true,
    token_hash: true,
    token_expires_at: true,
    verified_at: true,
    created_by: true,
    created_at: true,
  },
  notification_cursor: { id: true, last_event_id: true, last_audit_id: true, updated_at: true },
  email_outbox: {
    id: true,
    kind: true,
    organization_id: true,
    to_address: true,
    subject: true,
    body: true,
    dedupe_key: true,
    status: true,
    attempts: true,
    next_attempt_at: true,
    locked_until: true,
    last_error: true,
    created_at: true,
    sent_at: true,
  },
  webhook_deliveries: {
    id: true,
    endpoint_id: true,
    organization_id: true,
    event_id: true,
    status: true,
    attempts: true,
    next_attempt_at: true,
    locked_until: true,
    last_attempt_at: true,
    last_status_code: true,
    last_error: true,
    delivered_at: true,
    created_at: true,
  },
  platform_settings: {
    id: true,
    withdrawals_paused: true,
    pause_reason: true,
    updated_by: true,
    updated_at: true,
  },
  hot_wallets: {
    id: true,
    chain: true,
    network: true,
    address: true,
    label: true,
    status: true,
    created_at: true,
  },
  withdrawal_destinations: {
    id: true,
    organization_id: true,
    chain: true,
    address: true,
    destination_tag: true,
    label: true,
    created_by: true,
    created_at: true,
    active_at: true,
    revoked_at: true,
    revoked_by: true,
  },
  withdrawal_policy_versions: {
    id: true,
    organization_id: true,
    asset_id: true,
    enabled: true,
    min_amount: true,
    max_per_withdrawal: true,
    max_per_day: true,
    effective_at: true,
    created_by: true,
    created_at: true,
  },
  withdrawals: {
    id: true,
    organization_id: true,
    asset_id: true,
    amount: true,
    fee_charged: true,
    destination_id: true,
    destination_address: true,
    destination_tag: true,
    client_ref: true,
    description: true,
    status: true,
    requested_by_type: true,
    requested_by_id: true,
    hold_journal_id: true,
    approved_by: true,
    approved_at: true,
    approval_expires_at: true,
    approval_seal: true,
    decided_by: true,
    decided_at: true,
    decision_reason: true,
    release_journal_id: true,
    hot_address: true,
    signed_at: true,
    signed_tx: true,
    txid: true,
    nonce: true,
    inputs: true,
    planned_network_fee: true,
    broadcast_at: true,
    broadcast_attempts: true,
    last_error: true,
    confirmed_at: true,
    confirmations: true,
    block_height: true,
    final_network_fee: true,
    settle_journal_id: true,
    last_checked_at: true,
    created_at: true,
    updated_at: true,
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
