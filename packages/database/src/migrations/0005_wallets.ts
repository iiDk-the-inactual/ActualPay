/**
 * Wallets (watch-only) and the deposit addresses derived from them.
 *
 * A wallet is an account-level extended PUBLIC key (or, for XRPL, one
 * receiving account). Nothing in these tables can spend funds.
 *
 * Safety properties enforced here, not only in application code:
 *  - an account key (by serialization-independent id) belongs to exactly one
 *    wallet, so two organizations can never be handed the same address;
 *  - a deposit address (and XRPL address+tag pair) is unique across the whole
 *    deployment and rows are append-only, so an address is never reassigned;
 *  - key material, chain and network never change after creation, and the
 *    derivation counter only moves forward;
 *  - a wallet cannot be deleted, only archived (late payments to old
 *    addresses must still be recognised).
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE wallets (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id  uuid NOT NULL REFERENCES organizations (id),
      chain            text NOT NULL CHECK (chain IN ('bitcoin', 'litecoin', 'ethereum', 'tron', 'xrpl')),
      network          text NOT NULL CHECK (network IN ('mainnet', 'testnet')),
      label            text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
      -- Account-level extended public key as supplied (xpub/zpub/tpub/...). NULL for XRPL.
      account_xpub     text CHECK (char_length(account_xpub) BETWEEN 100 AND 130),
      -- SHA-256 of public key + chain code: identifies the key whatever its encoding.
      key_id           text CHECK (key_id ~ '^[0-9a-f]{64}$'),
      xrpl_address     text CHECK (char_length(xrpl_address) BETWEEN 25 AND 35),
      -- Next derivation index (account chains) or next destination tag (XRPL).
      next_index       bigint NOT NULL,
      status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      verified_at      timestamptz,
      verified_by      uuid REFERENCES users (id),
      created_by       uuid NOT NULL REFERENCES users (id),
      archived_at      timestamptz,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT wallets_shape CHECK (
        (chain = 'xrpl' AND xrpl_address IS NOT NULL AND account_xpub IS NULL AND key_id IS NULL)
        OR (chain <> 'xrpl' AND xrpl_address IS NULL AND account_xpub IS NOT NULL AND key_id IS NOT NULL)
      ),
      CONSTRAINT wallets_next_index CHECK (
        (chain = 'xrpl' AND next_index BETWEEN 1 AND 4294967296)
        OR (chain <> 'xrpl' AND next_index BETWEEN 0 AND 2147483648)
      ),
      CONSTRAINT wallets_verified_pair CHECK ((verified_at IS NULL) = (verified_by IS NULL)),
      CONSTRAINT wallets_archived_pair CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
      CONSTRAINT wallets_org_id_unique UNIQUE (id, organization_id, chain, network)
    );
    CREATE UNIQUE INDEX wallets_key_unique ON wallets (chain, network, key_id) WHERE key_id IS NOT NULL;
    CREATE UNIQUE INDEX wallets_xrpl_unique ON wallets (network, xrpl_address) WHERE xrpl_address IS NOT NULL;
    CREATE INDEX wallets_org ON wallets (organization_id, created_at DESC);

    CREATE TRIGGER wallets_updated_at BEFORE UPDATE ON wallets
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER wallets_no_delete BEFORE DELETE ON wallets
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    CREATE TRIGGER wallets_no_truncate BEFORE TRUNCATE ON wallets
      FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

    CREATE FUNCTION wallets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
    CREATE TRIGGER wallets_guard BEFORE UPDATE ON wallets
      FOR EACH ROW EXECUTE FUNCTION wallets_guard();

    CREATE TABLE deposit_addresses (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      wallet_id        uuid NOT NULL,
      organization_id  uuid NOT NULL,
      chain            text NOT NULL,
      network          text NOT NULL,
      address          text NOT NULL CHECK (char_length(address) BETWEEN 20 AND 100),
      derivation_index bigint,
      destination_tag  bigint,
      -- What this address was issued for (an invoice id from Phase 5 on).
      reference_type   text CHECK (char_length(reference_type) <= 50),
      reference_id     text CHECK (char_length(reference_id) <= 100),
      created_at       timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (wallet_id, organization_id, chain, network)
        REFERENCES wallets (id, organization_id, chain, network),
      CONSTRAINT deposit_addresses_shape CHECK (
        (chain = 'xrpl' AND destination_tag BETWEEN 1 AND 4294967295 AND derivation_index IS NULL)
        OR (chain <> 'xrpl' AND derivation_index BETWEEN 0 AND 2147483647 AND destination_tag IS NULL)
      ),
      CONSTRAINT deposit_addresses_reference_pair CHECK ((reference_type IS NULL) = (reference_id IS NULL))
    );
    CREATE UNIQUE INDEX deposit_addresses_wallet_index ON deposit_addresses (wallet_id, derivation_index)
      WHERE derivation_index IS NOT NULL;
    CREATE UNIQUE INDEX deposit_addresses_wallet_tag ON deposit_addresses (wallet_id, destination_tag)
      WHERE destination_tag IS NOT NULL;
    -- One address (or address+tag) is issued once, ever, across the deployment.
    CREATE UNIQUE INDEX deposit_addresses_unique ON deposit_addresses (chain, network, address, destination_tag)
      NULLS NOT DISTINCT;
    CREATE INDEX deposit_addresses_lookup ON deposit_addresses (address);
    CREATE INDEX deposit_addresses_org ON deposit_addresses (organization_id, created_at DESC);
    CREATE INDEX deposit_addresses_reference ON deposit_addresses (reference_type, reference_id)
      WHERE reference_id IS NOT NULL;

    CREATE TRIGGER deposit_addresses_immutable BEFORE UPDATE OR DELETE ON deposit_addresses
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    CREATE TRIGGER deposit_addresses_no_truncate BEFORE TRUNCATE ON deposit_addresses
      FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
  `.execute(db);
}
