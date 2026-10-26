/**
 * Withdrawals: destinations, policies, hot-wallet registry, the withdrawal
 * state machine, and the platform pause switch.
 *
 * Money safety is enforced here as well as in code:
 *  - a withdrawal can only move along the allowed transitions; once it is
 *    signed, nothing about what it pays can change, and a signed transaction
 *    is never overwritten;
 *  - destinations and limit policies are append-only, so history can always be
 *    reconstructed and an attacker cannot quietly edit them;
 *  - the signed transaction and its txid are written BEFORE broadcast, so a
 *    lost response can always be reconciled by txid.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE platform_settings (
      id                 boolean PRIMARY KEY DEFAULT true CHECK (id),
      withdrawals_paused boolean NOT NULL DEFAULT false,
      pause_reason       text CHECK (char_length(pause_reason) <= 500),
      updated_by         uuid REFERENCES users (id),
      updated_at         timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO platform_settings (id) VALUES (true);
    CREATE TRIGGER platform_settings_no_delete BEFORE DELETE ON platform_settings
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

    CREATE TABLE hot_wallets (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      chain       text NOT NULL CHECK (chain IN ('bitcoin', 'litecoin', 'ethereum', 'tron', 'xrpl')),
      network     text NOT NULL CHECK (network IN ('mainnet', 'testnet')),
      address     text NOT NULL CHECK (char_length(address) BETWEEN 20 AND 100),
      label       text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
      status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX hot_wallets_address ON hot_wallets (chain, network, address);
    -- At most one active hot wallet per chain and network.
    CREATE UNIQUE INDEX hot_wallets_one_active ON hot_wallets (chain, network) WHERE status = 'active';
    CREATE TRIGGER hot_wallets_no_delete BEFORE DELETE ON hot_wallets
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

    CREATE TABLE withdrawal_destinations (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id  uuid NOT NULL REFERENCES organizations (id),
      chain            text NOT NULL CHECK (chain IN ('bitcoin', 'litecoin', 'ethereum', 'tron', 'xrpl')),
      address          text NOT NULL CHECK (char_length(address) BETWEEN 20 AND 100),
      destination_tag  bigint CHECK (destination_tag BETWEEN 0 AND 4294967295),
      label            text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
      created_by       uuid NOT NULL REFERENCES users (id),
      created_at       timestamptz NOT NULL DEFAULT now(),
      -- A new destination cannot be used until this moment (cool-down).
      active_at        timestamptz NOT NULL,
      revoked_at       timestamptz,
      revoked_by       uuid REFERENCES users (id),
      CONSTRAINT destination_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
      CONSTRAINT destination_cooldown CHECK (active_at >= created_at)
    );
    CREATE UNIQUE INDEX withdrawal_destinations_unique
      ON withdrawal_destinations (organization_id, chain, address, destination_tag) NULLS NOT DISTINCT
      WHERE revoked_at IS NULL;
    CREATE INDEX withdrawal_destinations_org ON withdrawal_destinations (organization_id, created_at DESC);
    CREATE TRIGGER withdrawal_destinations_no_delete BEFORE DELETE ON withdrawal_destinations
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    CREATE FUNCTION withdrawal_destinations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
         OR NEW.chain IS DISTINCT FROM OLD.chain
         OR NEW.address IS DISTINCT FROM OLD.address
         OR NEW.destination_tag IS DISTINCT FROM OLD.destination_tag
         OR NEW.active_at IS DISTINCT FROM OLD.active_at
         OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'withdrawal destination % address and cool-down are immutable', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION 'withdrawal destination % is already revoked', OLD.id USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER withdrawal_destinations_guard BEFORE UPDATE ON withdrawal_destinations
      FOR EACH ROW EXECUTE FUNCTION withdrawal_destinations_guard();

    -- Limit policies are versions: never edited, only superseded. No policy = no withdrawals.
    CREATE TABLE withdrawal_policy_versions (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id     uuid NOT NULL REFERENCES organizations (id),
      asset_id            text NOT NULL REFERENCES assets (id),
      enabled             boolean NOT NULL,
      min_amount          numeric(78,0) NOT NULL CHECK (min_amount >= 0),
      max_per_withdrawal  numeric(78,0) NOT NULL CHECK (max_per_withdrawal >= 0),
      max_per_day         numeric(78,0) NOT NULL CHECK (max_per_day >= 0),
      -- Loosening takes effect after a delay; tightening takes effect at once.
      effective_at        timestamptz NOT NULL,
      created_by          uuid NOT NULL REFERENCES users (id),
      created_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT policy_limits CHECK (max_per_withdrawal <= max_per_day AND min_amount <= max_per_withdrawal OR NOT enabled)
    );
    CREATE INDEX withdrawal_policy_lookup
      ON withdrawal_policy_versions (organization_id, asset_id, effective_at DESC);
    CREATE TRIGGER withdrawal_policy_immutable BEFORE UPDATE OR DELETE ON withdrawal_policy_versions
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

    CREATE TABLE withdrawals (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id       uuid NOT NULL REFERENCES organizations (id),
      asset_id              text NOT NULL REFERENCES assets (id),
      amount                numeric(78,0) NOT NULL CHECK (amount > 0),
      -- Platform fee charged to the merchant, held with the amount.
      fee_charged           numeric(78,0) NOT NULL DEFAULT 0 CHECK (fee_charged >= 0),
      destination_id        uuid NOT NULL REFERENCES withdrawal_destinations (id),
      destination_address   text NOT NULL,
      destination_tag       bigint,
      client_ref            text CHECK (char_length(client_ref) BETWEEN 1 AND 200),
      description           text CHECK (char_length(description) <= 500),
      status                text NOT NULL DEFAULT 'pending_approval' CHECK (status IN (
        'pending_approval', 'approved', 'rejected', 'cancelled', 'expired',
        'signed', 'broadcast', 'confirmed', 'failed', 'needs_review')),
      requested_by_type     text NOT NULL CHECK (requested_by_type IN ('user', 'api_key')),
      requested_by_id       text NOT NULL CHECK (char_length(requested_by_id) <= 100),
      hold_journal_id       uuid NOT NULL REFERENCES ledger_journals (id),
      approved_by           uuid REFERENCES users (id),
      approved_at           timestamptz,
      approval_expires_at   timestamptz,
      -- HMAC over the approved fields with a key the database does not hold.
      approval_seal         text CHECK (approval_seal ~ '^[0-9a-f]{64}$'),
      decided_by            uuid REFERENCES users (id),
      decided_at            timestamptz,
      decision_reason       text CHECK (char_length(decision_reason) <= 500),
      release_journal_id    uuid REFERENCES ledger_journals (id),
      hot_address           text,
      signed_at             timestamptz,
      signed_tx             text CHECK (char_length(signed_tx) <= 200000),
      txid                  text CHECK (char_length(txid) BETWEEN 8 AND 128),
      nonce                 bigint,
      -- UTXO chains: the outpoints (txid:vout) this transaction spends.
      inputs                text[],
      planned_network_fee   numeric(78,0) CHECK (planned_network_fee >= 0),
      broadcast_at          timestamptz,
      broadcast_attempts    integer NOT NULL DEFAULT 0 CHECK (broadcast_attempts >= 0),
      last_error            text CHECK (char_length(last_error) <= 500),
      confirmed_at          timestamptz,
      confirmations         numeric(78,0) NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
      block_height          numeric(78,0),
      final_network_fee     numeric(78,0) CHECK (final_network_fee >= 0),
      settle_journal_id     uuid REFERENCES ledger_journals (id),
      last_checked_at       timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT withdrawals_approved_fields CHECK (
        status IN ('pending_approval', 'rejected', 'cancelled')
        OR (approved_by IS NOT NULL AND approved_at IS NOT NULL
            AND approval_expires_at IS NOT NULL AND approval_seal IS NOT NULL)),
      CONSTRAINT withdrawals_signed_fields CHECK (
        status NOT IN ('signed', 'broadcast', 'confirmed', 'needs_review')
        OR (signed_tx IS NOT NULL AND txid IS NOT NULL AND hot_address IS NOT NULL AND signed_at IS NOT NULL)),
      CONSTRAINT withdrawals_confirmed_fields CHECK (
        status <> 'confirmed' OR (confirmed_at IS NOT NULL AND settle_journal_id IS NOT NULL)),
      CONSTRAINT withdrawals_no_self_approval CHECK (
        approved_by IS NULL OR requested_by_type <> 'user' OR approved_by::text <> requested_by_id)
    );
    CREATE UNIQUE INDEX withdrawals_client_ref ON withdrawals (organization_id, client_ref)
      WHERE client_ref IS NOT NULL;
    CREATE UNIQUE INDEX withdrawals_txid ON withdrawals (txid) WHERE txid IS NOT NULL;
    CREATE INDEX withdrawals_org_created ON withdrawals (organization_id, created_at DESC, id DESC);
    CREATE INDEX withdrawals_status ON withdrawals (status) WHERE status NOT IN
      ('rejected', 'cancelled', 'expired', 'confirmed', 'failed');
    CREATE TRIGGER withdrawals_updated_at BEFORE UPDATE ON withdrawals
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER withdrawals_no_delete BEFORE DELETE ON withdrawals
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    CREATE TRIGGER withdrawals_no_truncate BEFORE TRUNCATE ON withdrawals
      FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

    CREATE FUNCTION withdrawals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
         OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
         OR NEW.amount IS DISTINCT FROM OLD.amount
         OR NEW.fee_charged IS DISTINCT FROM OLD.fee_charged
         OR NEW.destination_id IS DISTINCT FROM OLD.destination_id
         OR NEW.destination_address IS DISTINCT FROM OLD.destination_address
         OR NEW.destination_tag IS DISTINCT FROM OLD.destination_tag
         OR NEW.hold_journal_id IS DISTINCT FROM OLD.hold_journal_id
         OR NEW.requested_by_type IS DISTINCT FROM OLD.requested_by_type
         OR NEW.requested_by_id IS DISTINCT FROM OLD.requested_by_id THEN
        RAISE EXCEPTION 'withdrawal % amount, destination and requester are immutable', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      -- Approval facts are written once.
      IF OLD.approval_seal IS NOT NULL AND (
            NEW.approval_seal IS DISTINCT FROM OLD.approval_seal
         OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
         OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
         OR NEW.approval_expires_at IS DISTINCT FROM OLD.approval_expires_at) THEN
        RAISE EXCEPTION 'withdrawal % approval cannot be changed', OLD.id USING ERRCODE = 'check_violation';
      END IF;
      -- Once signed, the transaction is fixed.
      IF OLD.signed_tx IS NOT NULL AND (
            NEW.signed_tx IS DISTINCT FROM OLD.signed_tx
         OR NEW.txid IS DISTINCT FROM OLD.txid
         OR NEW.hot_address IS DISTINCT FROM OLD.hot_address
         OR NEW.nonce IS DISTINCT FROM OLD.nonce
         OR NEW.inputs IS DISTINCT FROM OLD.inputs) THEN
        RAISE EXCEPTION 'withdrawal % signed transaction cannot be changed', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.status <> NEW.status AND NOT (
           (OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
        OR (OLD.status = 'approved'         AND NEW.status IN ('signed', 'cancelled', 'expired'))
        OR (OLD.status = 'signed'           AND NEW.status IN ('broadcast', 'needs_review'))
        OR (OLD.status = 'broadcast'        AND NEW.status IN ('confirmed', 'failed', 'needs_review'))
        OR (OLD.status = 'needs_review'     AND NEW.status IN ('broadcast', 'confirmed', 'failed'))) THEN
        RAISE EXCEPTION 'withdrawal % cannot go from % to %', OLD.id, OLD.status, NEW.status
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER withdrawals_guard BEFORE UPDATE ON withdrawals
      FOR EACH ROW EXECUTE FUNCTION withdrawals_guard();
  `.execute(db);
}
