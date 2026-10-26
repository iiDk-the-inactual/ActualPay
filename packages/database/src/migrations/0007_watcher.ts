/**
 * Chain watching: scan cursors, job leases, reconciliation issues.
 *
 * Safety rule behind these tables: an address is only handed to a payer if
 * something is watching it. `chain_cursors` has a row only once a watcher has
 * started scanning that chain, and `wallets.watched_through` records how far
 * the node's imported address range reaches (UTXO chains). Invoice creation
 * checks both, so there is no window in which a payment can arrive unobserved.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE wallets ADD COLUMN watched_through bigint NOT NULL DEFAULT 0
      CHECK (watched_through >= 0 AND watched_through <= 4294967296);
    ALTER TABLE payments ADD COLUMN last_checked_at timestamptz;

    CREATE OR REPLACE FUNCTION wallets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
         OR NEW.chain IS DISTINCT FROM OLD.chain
         OR NEW.network IS DISTINCT FROM OLD.network
         OR NEW.account_xpub IS DISTINCT FROM OLD.account_xpub
         OR NEW.key_id IS DISTINCT FROM OLD.key_id
         OR NEW.xrpl_address IS DISTINCT FROM OLD.xrpl_address
         OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'wallet % key material, chain, network and owner are immutable', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.next_index < OLD.next_index THEN
        RAISE EXCEPTION 'wallet % derivation counter cannot move backwards', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.watched_through < OLD.watched_through THEN
        RAISE EXCEPTION 'wallet % watched range cannot shrink', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.verified_at IS NOT NULL AND (NEW.verified_at IS DISTINCT FROM OLD.verified_at
                                          OR NEW.verified_by IS DISTINCT FROM OLD.verified_by) THEN
        RAISE EXCEPTION 'wallet % verification cannot be changed', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.status = 'archived' AND NEW.status <> 'archived' THEN
        RAISE EXCEPTION 'wallet % is archived and cannot be reactivated', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TABLE chain_cursors (
      chain          text NOT NULL CHECK (chain IN ('bitcoin', 'litecoin', 'ethereum', 'tron', 'xrpl')),
      network        text NOT NULL CHECK (network IN ('mainnet', 'testnet')),
      -- The adapter's opaque resume point. Saved only after every transfer up to it was processed.
      cursor         text NOT NULL CHECK (char_length(cursor) BETWEEN 1 AND 1000),
      initialised_at timestamptz NOT NULL DEFAULT now(),
      scanned_at     timestamptz,
      tip_height     numeric(78,0),
      final_height   numeric(78,0),
      synced         boolean,
      last_error     text CHECK (char_length(last_error) <= 1000),
      last_error_at  timestamptz,
      updated_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (chain, network)
    );
    CREATE TRIGGER chain_cursors_updated_at BEFORE UPDATE ON chain_cursors
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER chain_cursors_no_delete BEFORE DELETE ON chain_cursors
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

    CREATE TABLE job_leases (
      name             text PRIMARY KEY CHECK (name ~ '^[a-z0-9:_.-]{1,100}$'),
      locked_by        text CHECK (char_length(locked_by) <= 100),
      locked_until     timestamptz,
      last_started_at  timestamptz,
      last_finished_at timestamptz,
      last_error       text CHECK (char_length(last_error) <= 1000),
      last_error_at    timestamptz,
      run_count        bigint NOT NULL DEFAULT 0
    );

    CREATE TABLE reconciliation_issues (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind             text NOT NULL CHECK (kind ~ '^[a-z][a-z_]{2,60}$'),
      severity         text NOT NULL CHECK (severity IN ('warning', 'critical')),
      status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      subject_type     text NOT NULL CHECK (char_length(subject_type) <= 50),
      subject_id       text NOT NULL CHECK (char_length(subject_id) <= 255),
      organization_id  uuid REFERENCES organizations (id),
      summary          text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
      details          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
      occurrences      integer NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
      first_seen_at    timestamptz NOT NULL DEFAULT now(),
      last_seen_at     timestamptz NOT NULL DEFAULT now(),
      resolved_at      timestamptz,
      resolved_by      uuid REFERENCES users (id),
      resolution_note  text CHECK (char_length(resolution_note) <= 2000),
      CONSTRAINT reconciliation_resolved_pair CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
    );
    -- One open issue per (kind, subject): repeats bump the counter instead of piling up.
    CREATE UNIQUE INDEX reconciliation_open ON reconciliation_issues (kind, subject_type, subject_id)
      WHERE status = 'open';
    CREATE INDEX reconciliation_status ON reconciliation_issues (status, severity, last_seen_at DESC);
    CREATE TRIGGER reconciliation_no_delete BEFORE DELETE ON reconciliation_issues
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
  `.execute(db);
}
