/**
 * Double-entry ledger.
 *
 *  ledger_accounts  one row per (owner, asset, account type); `balance` is a
 *                   cached running total maintained in the same transaction
 *                   as the entries that change it.
 *  ledger_journals  one row per financial event; `external_ref` is unique and
 *                   is the idempotency key that makes double-crediting a
 *                   database-level impossibility (e.g. "deposit:btc:<txid>:<vout>").
 *  ledger_entries   immutable debit/credit lines. Every journal must balance
 *                   (debits = credits) per asset; this is checked by a
 *                   deferred constraint trigger at COMMIT, so no code path —
 *                   including a buggy one — can persist an unbalanced journal.
 *
 * Sign convention: entry amounts are always positive with an explicit
 * direction. An account's balance moves up when an entry's direction equals
 * the account's normal side. See docs/ledger.md for the chart of accounts.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE ledger_accounts (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id  uuid REFERENCES organizations (id),
      asset_id         text NOT NULL REFERENCES assets (id),
      type             text NOT NULL CHECK (type IN (
                         'custody', 'network_fees', 'platform_revenue', 'suspense',
                         'org_available', 'org_withdrawal_hold')),
      normal_side      text NOT NULL CHECK (normal_side IN ('debit', 'credit')),
      allow_negative   boolean NOT NULL DEFAULT false,
      balance          numeric(78, 0) NOT NULL DEFAULT 0,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),

      -- Lets ledger_entries reference (account, asset) together, proving at
      -- the schema level that an entry's asset is its account's asset.
      UNIQUE (id, asset_id),
      UNIQUE NULLS NOT DISTINCT (organization_id, asset_id, type),

      CONSTRAINT ledger_accounts_owner CHECK (
        (type IN ('org_available', 'org_withdrawal_hold')) = (organization_id IS NOT NULL)),
      CONSTRAINT ledger_accounts_normal_side CHECK (
        (type IN ('custody', 'network_fees', 'suspense') AND normal_side = 'debit') OR
        (type IN ('platform_revenue', 'org_available', 'org_withdrawal_hold') AND normal_side = 'credit')),
      -- Only the suspense account (reconciliation differences) may go negative.
      CONSTRAINT ledger_accounts_allow_negative CHECK (allow_negative = (type = 'suspense')),
      -- The core overdraft guard. Concurrent withdrawals that would together
      -- overspend serialise on the account row lock and the loser fails here.
      CONSTRAINT ledger_accounts_non_negative CHECK (allow_negative OR balance >= 0)
    );

    -- Only the cached balance may change; identity and policy columns are fixed.
    CREATE FUNCTION ledger_accounts_guard_update() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id <> OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
         OR NEW.asset_id <> OLD.asset_id OR NEW.type <> OLD.type
         OR NEW.normal_side <> OLD.normal_side OR NEW.allow_negative <> OLD.allow_negative
         OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'only balance may change on ledger_accounts'
          USING ERRCODE = 'restrict_violation';
      END IF;
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER ledger_accounts_guard BEFORE UPDATE ON ledger_accounts
      FOR EACH ROW EXECUTE FUNCTION ledger_accounts_guard_update();
    CREATE TRIGGER ledger_accounts_no_delete BEFORE DELETE ON ledger_accounts
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

    CREATE TABLE ledger_journals (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      external_ref         text NOT NULL UNIQUE CHECK (char_length(external_ref) BETWEEN 1 AND 255),
      kind                 text NOT NULL CHECK (kind IN (
                             'deposit_confirmed', 'deposit_reversed',
                             'withdrawal_hold', 'withdrawal_release', 'withdrawal_settled',
                             'network_fee', 'platform_fee', 'sweep', 'adjustment', 'reversal')),
      organization_id      uuid REFERENCES organizations (id),
      -- SHA-256 of the canonical line set. A retried post with the same
      -- external_ref must carry identical lines, otherwise it is a bug or an
      -- attack and is rejected rather than silently treated as a duplicate.
      content_hash         text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      reverses_journal_id  uuid UNIQUE REFERENCES ledger_journals (id),
      description          text CHECK (char_length(description) <= 500),
      metadata             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
      created_at           timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ledger_journals_reversal_kind CHECK ((kind = 'reversal') = (reverses_journal_id IS NOT NULL))
    );

    CREATE INDEX ledger_journals_org_created ON ledger_journals (organization_id, created_at DESC);

    CREATE TABLE ledger_entries (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      journal_id  uuid NOT NULL REFERENCES ledger_journals (id),
      account_id  uuid NOT NULL,
      asset_id    text NOT NULL,
      direction   text NOT NULL CHECK (direction IN ('debit', 'credit')),
      amount      numeric(78, 0) NOT NULL CHECK (amount > 0),
      created_at  timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (account_id, asset_id) REFERENCES ledger_accounts (id, asset_id)
    );

    CREATE INDEX ledger_entries_journal ON ledger_entries (journal_id);
    CREATE INDEX ledger_entries_account_created ON ledger_entries (account_id, created_at DESC);

    CREATE TRIGGER ledger_journals_immutable BEFORE UPDATE OR DELETE ON ledger_journals
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    -- TRUNCATE bypasses row triggers, so block it explicitly too.
    CREATE TRIGGER ledger_journals_no_truncate BEFORE TRUNCATE ON ledger_journals
      FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
    CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
      FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

    -- Runs at COMMIT for every journal touched in the transaction.
    CREATE FUNCTION ledger_assert_journal_balanced() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      target uuid;
      line_count integer;
      unbalanced_asset text;
    BEGIN
      -- IF, not CASE: plpgsql resolves every field referenced in a CASE
      -- expression, and NEW has no journal_id when fired from ledger_journals.
      IF TG_TABLE_NAME = 'ledger_journals' THEN
        target := NEW.id;
      ELSE
        target := NEW.journal_id;
      END IF;

      SELECT count(*) INTO line_count FROM ledger_entries WHERE journal_id = target;
      IF line_count < 2 THEN
        RAISE EXCEPTION 'ledger journal % has % entries; at least 2 required', target, line_count
          USING ERRCODE = 'check_violation';
      END IF;

      SELECT asset_id INTO unbalanced_asset
      FROM ledger_entries
      WHERE journal_id = target
      GROUP BY asset_id
      HAVING sum(CASE direction WHEN 'debit' THEN amount ELSE -amount END) <> 0
      LIMIT 1;

      IF unbalanced_asset IS NOT NULL THEN
        RAISE EXCEPTION 'ledger journal % does not balance for asset %', target, unbalanced_asset
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NULL;
    END;
    $$;

    CREATE CONSTRAINT TRIGGER ledger_journal_balanced_on_journal
      AFTER INSERT ON ledger_journals DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ledger_assert_journal_balanced();
    CREATE CONSTRAINT TRIGGER ledger_journal_balanced_on_entry
      AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ledger_assert_journal_balanced();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE ledger_entries;
    DROP TABLE ledger_journals;
    DROP FUNCTION ledger_assert_journal_balanced();
    DROP TABLE ledger_accounts;
    DROP FUNCTION ledger_accounts_guard_update();
  `.execute(db);
}
