/**
 * Kysely table types. These mirror the migrations by hand; the integration
 * test `schema-drift.test.ts` compares them against information_schema so
 * drift is caught in CI.
 *
 * numeric(78,0) columns are typed as `string` because that is what node-pg
 * returns. Convert with `toBaseUnits()` at the repository boundary; never
 * pass these strings through `Number()`.
 */
import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, never>;
type Numeric = ColumnType<string, string | bigint, string | bigint>;
type Json = ColumnType<Record<string, unknown>, string | undefined, never>;

export type LedgerAccountType =
  | 'custody'
  | 'network_fees'
  | 'platform_revenue'
  | 'suspense'
  | 'org_available'
  | 'org_withdrawal_hold';

export type LedgerDirection = 'debit' | 'credit';

export type JournalKind =
  | 'deposit_confirmed'
  | 'deposit_reversed'
  | 'withdrawal_hold'
  | 'withdrawal_release'
  | 'withdrawal_settled'
  | 'network_fee'
  | 'platform_fee'
  | 'sweep'
  | 'adjustment'
  | 'reversal';

export interface OrganizationsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  status: ColumnType<'active' | 'suspended', 'active' | 'suspended' | undefined>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AssetsTable {
  id: string;
  chain: string;
  symbol: string;
  kind: 'native' | 'token';
  decimals: number;
  fee_asset_id: string;
  created_at: Timestamp;
}

export interface LedgerAccountsTable {
  id: Generated<string>;
  organization_id: string | null;
  asset_id: string;
  type: LedgerAccountType;
  normal_side: LedgerDirection;
  allow_negative: ColumnType<boolean, boolean | undefined, never>;
  balance: ColumnType<string, never, string | bigint>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface LedgerJournalsTable {
  id: Generated<string>;
  external_ref: string;
  kind: JournalKind;
  organization_id: string | null;
  content_hash: string;
  reverses_journal_id: string | null;
  description: string | null;
  metadata: Json;
  created_at: Timestamp;
}

export interface LedgerEntriesTable {
  id: Generated<string>;
  journal_id: string;
  account_id: string;
  asset_id: string;
  direction: LedgerDirection;
  amount: Numeric;
  created_at: Timestamp;
}

export interface AuditLogTable {
  id: ColumnType<string, never, never>;
  occurred_at: Timestamp;
  actor_type: 'user' | 'api_key' | 'system';
  actor_id: string | null;
  organization_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  request_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Json;
}

export interface IdempotencyKeysTable {
  id: Generated<string>;
  organization_id: string;
  scope: string;
  key: string;
  request_hash: string;
  state: ColumnType<'in_progress' | 'completed', 'in_progress' | 'completed' | undefined>;
  response_status: number | null;
  response_body: ColumnType<unknown, string | null | undefined, string | null>;
  locked_until: ColumnType<Date | null, Date | string | null | undefined>;
  created_at: Timestamp;
  expires_at: ColumnType<Date, Date | string, Date | string>;
}

export type OrgRole = 'owner' | 'admin' | 'finance' | 'developer' | 'viewer';
export type AuthTokenPurpose = 'email_verification' | 'password_reset' | 'mfa_challenge';
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type MutableTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface UsersTable {
  id: Generated<string>;
  email: string;
  email_verified_at: NullableTimestamp;
  password_hash: string;
  display_name: string;
  status: ColumnType<'active' | 'disabled', 'active' | 'disabled' | undefined>;
  is_platform_admin: ColumnType<boolean, boolean | undefined>;
  failed_login_count: ColumnType<number, number | undefined>;
  locked_until: NullableTimestamp;
  password_changed_at: MutableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrganizationMembersTable {
  organization_id: string;
  user_id: string;
  role: OrgRole;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  mfa_verified: boolean;
  created_at: Timestamp;
  last_seen_at: MutableTimestamp;
  idle_expires_at: MutableTimestamp;
  expires_at: ColumnType<Date, Date | string, never>;
  revoked_at: NullableTimestamp;
  revoked_reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

export interface AuthTokensTable {
  id: Generated<string>;
  user_id: string;
  purpose: AuthTokenPurpose;
  token_hash: string;
  expires_at: ColumnType<Date, Date | string, never>;
  consumed_at: NullableTimestamp;
  attempts: ColumnType<number, number | undefined>;
  created_at: Timestamp;
}

export interface TotpCredentialsTable {
  user_id: string;
  secret_ciphertext: string;
  confirmed_at: NullableTimestamp;
  last_used_step: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Timestamp;
}

export interface RecoveryCodesTable {
  id: Generated<string>;
  user_id: string;
  code_hash: string;
  used_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface OrganizationInvitationsTable {
  id: Generated<string>;
  organization_id: string;
  email: string;
  role: OrgRole;
  token_hash: string;
  invited_by: string;
  expires_at: ColumnType<Date, Date | string, never>;
  accepted_at: NullableTimestamp;
  accepted_by: string | null;
  revoked_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface ApiKeysTable {
  id: Generated<string>;
  organization_id: string;
  public_id: string;
  secret_hash: string;
  name: string;
  scopes: ColumnType<string[], string[], never>;
  created_by: string;
  created_at: Timestamp;
  expires_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  revoked_at: NullableTimestamp;
  revoked_by: string | null;
  last_used_at: NullableTimestamp;
  last_used_ip: string | null;
  rotated_from_id: string | null;
}

export interface Database {
  organizations: OrganizationsTable;
  assets: AssetsTable;
  ledger_accounts: LedgerAccountsTable;
  ledger_journals: LedgerJournalsTable;
  ledger_entries: LedgerEntriesTable;
  audit_log: AuditLogTable;
  idempotency_keys: IdempotencyKeysTable;
  users: UsersTable;
  organization_members: OrganizationMembersTable;
  sessions: SessionsTable;
  auth_tokens: AuthTokensTable;
  totp_credentials: TotpCredentialsTable;
  recovery_codes: RecoveryCodesTable;
  organization_invitations: OrganizationInvitationsTable;
  api_keys: ApiKeysTable;
}

export type Organization = Selectable<OrganizationsTable>;
export type LedgerAccountRow = Selectable<LedgerAccountsTable>;
export type LedgerJournalRow = Selectable<LedgerJournalsTable>;
export type LedgerEntryRow = Selectable<LedgerEntriesTable>;
export type NewAuditLog = Insertable<AuditLogTable>;
