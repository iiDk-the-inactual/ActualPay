/**
 * Foundation: shared trigger functions, organizations, and the asset table.
 *
 * Migrations are written in plain SQL (wrapped in Kysely's `sql` tag) rather
 * than a schema builder so that reviewers see exactly what runs against the
 * database that holds financial records.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Raised by triggers on append-only tables. Financial history is
    -- corrected with new compensating rows, never edited or deleted.
    CREATE FUNCTION forbid_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'table % is append-only (% rejected)', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
    END;
    $$;

    CREATE FUNCTION set_updated_at() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $$;

    CREATE TABLE organizations (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug        text NOT NULL UNIQUE
                  CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$'),
      name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
      status      text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended')),
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );

    CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Organizations own financial history, so they are suspended, never deleted.
    CREATE TRIGGER organizations_no_delete BEFORE DELETE ON organizations
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

    -- Protocol facts about each asset. Rows are synchronised from the
    -- code-reviewed registry in @actualpay/shared on every migrate run;
    -- per-deployment settings (contracts, enabled flags) live in config.
    CREATE TABLE assets (
      id            text PRIMARY KEY CHECK (id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
      chain         text NOT NULL CHECK (chain IN ('bitcoin', 'litecoin', 'ethereum', 'tron', 'xrpl')),
      symbol        text NOT NULL,
      kind          text NOT NULL CHECK (kind IN ('native', 'token')),
      decimals      smallint NOT NULL CHECK (decimals BETWEEN 0 AND 18),
      fee_asset_id  text NOT NULL REFERENCES assets (id) DEFERRABLE INITIALLY DEFERRED,
      created_at    timestamptz NOT NULL DEFAULT now()
    );

    -- Changing an asset's decimals after amounts exist would silently rescale
    -- every stored amount, so the protocol columns are frozen once written.
    CREATE FUNCTION assets_freeze_protocol_fields() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.decimals <> OLD.decimals OR NEW.chain <> OLD.chain OR NEW.kind <> OLD.kind
         OR NEW.fee_asset_id <> OLD.fee_asset_id OR NEW.id <> OLD.id THEN
        RAISE EXCEPTION 'protocol fields of asset % are immutable', OLD.id
          USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER assets_freeze BEFORE UPDATE ON assets
      FOR EACH ROW EXECUTE FUNCTION assets_freeze_protocol_fields();
    CREATE TRIGGER assets_no_delete BEFORE DELETE ON assets
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE assets;
    DROP FUNCTION assets_freeze_protocol_fields();
    DROP TABLE organizations;
    DROP FUNCTION set_updated_at();
    DROP FUNCTION forbid_mutation();
  `.execute(db);
}
