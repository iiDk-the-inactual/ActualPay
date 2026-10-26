/**
 * Invoices, payments, payment links and the domain-event outbox.
 *
 * Money rules enforced in the database, not only in code:
 *  - an invoice owns exactly one deposit address, issued once;
 *  - a payment is identified by the chain's own output reference (`ref`), so
 *    seeing the same transfer twice can never create two payments;
 *  - payments only move pending → confirmed → reversed (and back to pending if
 *    a reorged transaction is mined again); `epoch` counts confirmations so
 *    each confirmation has its own ledger reference;
 *  - a confirmed payment always points at the ledger journal that credited it;
 *  - domain events are append-only, written in the same transaction as the
 *    change they describe (so a webhook can never be lost or invented).
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE payment_links (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      public_id         text NOT NULL CHECK (public_id ~ '^[A-Za-z0-9_-]{22,64}$'),
      organization_id   uuid NOT NULL REFERENCES organizations (id),
      asset_id          text NOT NULL REFERENCES assets (id),
      amount            numeric(78,0) NOT NULL CHECK (amount > 0),
      title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
      description       text CHECK (char_length(description) <= 2000),
      invoice_ttl_minutes integer NOT NULL DEFAULT 60 CHECK (invoice_ttl_minutes BETWEEN 5 AND 43200),
      max_open_invoices integer NOT NULL DEFAULT 20 CHECK (max_open_invoices BETWEEN 1 AND 500),
      active            boolean NOT NULL DEFAULT true,
      created_by        uuid NOT NULL REFERENCES users (id),
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX payment_links_public_id ON payment_links (public_id);
    CREATE INDEX payment_links_org ON payment_links (organization_id, created_at DESC);
    CREATE TRIGGER payment_links_updated_at BEFORE UPDATE ON payment_links
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER payment_links_no_delete BEFORE DELETE ON payment_links
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    -- A link's price and asset are fixed once published.
    CREATE FUNCTION payment_links_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
         OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
         OR NEW.amount IS DISTINCT FROM OLD.amount
         OR NEW.public_id IS DISTINCT FROM OLD.public_id THEN
        RAISE EXCEPTION 'payment link % asset, amount and owner are immutable', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER payment_links_guard BEFORE UPDATE ON payment_links
      FOR EACH ROW EXECUTE FUNCTION payment_links_guard();

    CREATE TABLE invoices (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Unguessable id used on public pages and links.
      public_id           text NOT NULL CHECK (public_id ~ '^[A-Za-z0-9_-]{22,64}$'),
      organization_id     uuid NOT NULL REFERENCES organizations (id),
      wallet_id           uuid NOT NULL REFERENCES wallets (id),
      deposit_address_id  uuid NOT NULL REFERENCES deposit_addresses (id),
      payment_link_id     uuid REFERENCES payment_links (id),
      asset_id            text NOT NULL REFERENCES assets (id),
      amount_due          numeric(78,0) NOT NULL CHECK (amount_due > 0),
      -- Cached sums over this invoice's payments in the invoice asset.
      amount_confirmed    numeric(78,0) NOT NULL DEFAULT 0 CHECK (amount_confirmed >= 0),
      amount_pending      numeric(78,0) NOT NULL DEFAULT 0 CHECK (amount_pending >= 0),
      status              text NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'processing', 'partially_paid', 'paid', 'expired', 'cancelled')),
      -- Merchant's own reference (order id). Unique per organization when given.
      external_id         text CHECK (char_length(external_id) BETWEEN 1 AND 200),
      description         text CHECK (char_length(description) <= 2000),
      metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 4096),
      expires_at          timestamptz NOT NULL,
      cancelled_at        timestamptz,
      paid_at             timestamptz,
      -- True when the invoice was completed by a payment confirmed after expires_at.
      paid_late           boolean NOT NULL DEFAULT false,
      created_by_type     text NOT NULL CHECK (created_by_type IN ('user', 'api_key', 'payment_link')),
      created_by_id       text CHECK (char_length(created_by_id) <= 100),
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT invoices_cancel_state CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
    );
    CREATE UNIQUE INDEX invoices_public_id ON invoices (public_id);
    CREATE UNIQUE INDEX invoices_address ON invoices (deposit_address_id);
    CREATE UNIQUE INDEX invoices_external_id ON invoices (organization_id, external_id)
      WHERE external_id IS NOT NULL;
    CREATE INDEX invoices_org_created ON invoices (organization_id, created_at DESC, id DESC);
    CREATE INDEX invoices_org_status ON invoices (organization_id, status);
    -- The expiry sweep looks for unpaid invoices whose time is up.
    CREATE INDEX invoices_expiry ON invoices (expires_at)
      WHERE status IN ('open', 'partially_paid', 'processing');
    CREATE INDEX invoices_link ON invoices (payment_link_id) WHERE payment_link_id IS NOT NULL;
    CREATE TRIGGER invoices_updated_at BEFORE UPDATE ON invoices
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    CREATE FUNCTION invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
         OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
         OR NEW.deposit_address_id IS DISTINCT FROM OLD.deposit_address_id
         OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
         OR NEW.amount_due IS DISTINCT FROM OLD.amount_due
         OR NEW.public_id IS DISTINCT FROM OLD.public_id
         OR NEW.payment_link_id IS DISTINCT FROM OLD.payment_link_id
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'invoice % amount, asset, address and owner are immutable', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.status = 'cancelled' AND NEW.status NOT IN ('cancelled', 'paid') THEN
        RAISE EXCEPTION 'invoice % is cancelled', OLD.id USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER invoices_guard BEFORE UPDATE ON invoices
      FOR EACH ROW EXECUTE FUNCTION invoices_guard();

    CREATE TABLE payments (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id     uuid NOT NULL REFERENCES organizations (id),
      invoice_id          uuid NOT NULL REFERENCES invoices (id),
      deposit_address_id  uuid NOT NULL REFERENCES deposit_addresses (id),
      -- The chain's own unique reference for this credit (btc:<txid>:<vout>, ...).
      ref                 text NOT NULL CHECK (char_length(ref) BETWEEN 5 AND 255),
      asset_id            text NOT NULL REFERENCES assets (id),
      tx_hash             text NOT NULL CHECK (char_length(tx_hash) BETWEEN 8 AND 128),
      amount              numeric(78,0) NOT NULL CHECK (amount > 0),
      -- Whether this credit counts toward the invoice (same asset as the invoice).
      counts_toward_invoice boolean NOT NULL,
      status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'reversed')),
      -- Increments with each confirmation; makes each confirmation's ledger ref unique.
      epoch               integer NOT NULL DEFAULT 0 CHECK (epoch >= 0),
      block_height        numeric(78,0),
      block_hash          text,
      confirmations       numeric(78,0) NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
      deposit_journal_id  uuid REFERENCES ledger_journals (id),
      reversal_journal_id uuid REFERENCES ledger_journals (id),
      detected_at         timestamptz NOT NULL DEFAULT now(),
      confirmed_at        timestamptz,
      reversed_at         timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payments_confirmed_has_journal CHECK (status <> 'confirmed' OR deposit_journal_id IS NOT NULL),
      CONSTRAINT payments_reversed_has_journal CHECK (
        status <> 'reversed' OR reversal_journal_id IS NOT NULL OR deposit_journal_id IS NULL)
    );
    CREATE UNIQUE INDEX payments_ref ON payments (ref);
    CREATE INDEX payments_invoice ON payments (invoice_id, created_at);
    CREATE INDEX payments_org_created ON payments (organization_id, created_at DESC, id DESC);
    -- Watchers re-check everything not yet final.
    CREATE INDEX payments_open ON payments (status) WHERE status = 'pending';
    CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    CREATE TRIGGER payments_no_truncate BEFORE TRUNCATE ON payments
      FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
    CREATE FUNCTION payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.ref IS DISTINCT FROM OLD.ref
         OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
         OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
         OR NEW.deposit_address_id IS DISTINCT FROM OLD.deposit_address_id
         OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
         OR NEW.amount IS DISTINCT FROM OLD.amount
         OR NEW.tx_hash IS DISTINCT FROM OLD.tx_hash THEN
        RAISE EXCEPTION 'payment % identity and amount are immutable', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.epoch < OLD.epoch THEN
        RAISE EXCEPTION 'payment % epoch cannot move backwards', OLD.id USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.status <> NEW.status AND NOT (
           (OLD.status = 'pending'   AND NEW.status IN ('confirmed', 'reversed'))
        OR (OLD.status = 'confirmed' AND NEW.status = 'reversed')
        OR (OLD.status = 'reversed'  AND NEW.status = 'pending')) THEN
        RAISE EXCEPTION 'payment % cannot go from % to %', OLD.id, OLD.status, NEW.status
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER payments_guard BEFORE UPDATE ON payments
      FOR EACH ROW EXECUTE FUNCTION payments_guard();

    CREATE TABLE domain_events (
      id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      organization_id  uuid NOT NULL REFERENCES organizations (id),
      type             text NOT NULL CHECK (type ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
      subject_type     text NOT NULL CHECK (char_length(subject_type) <= 50),
      subject_id       text NOT NULL CHECK (char_length(subject_id) <= 100),
      payload          jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      occurred_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX domain_events_org ON domain_events (organization_id, id DESC);
    CREATE TRIGGER domain_events_immutable BEFORE UPDATE OR DELETE ON domain_events
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    CREATE TRIGGER domain_events_no_truncate BEFORE TRUNCATE ON domain_events
      FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
  `.execute(db);
}
