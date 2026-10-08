/**
 * Identity, sessions, MFA, memberships, invitations and API keys.
 *
 * Secrets are never stored in a recoverable form:
 *  - passwords: Argon2id hash (PHC string)
 *  - session tokens, one-time tokens, recovery codes, API key secrets:
 *    SHA-256 of a 256-bit random value. These are high-entropy, so a fast
 *    hash is sufficient and a database leak does not reveal usable tokens.
 *  - TOTP seeds: AES-256-GCM ciphertext (they must be recoverable to verify
 *    codes), bound to the owning user via associated data.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE users (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Stored already normalised (trimmed, NFC, lower-case) by the application.
      email               text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
      email_verified_at   timestamptz,
      password_hash       text NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
      display_name        text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
      status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      is_platform_admin   boolean NOT NULL DEFAULT false,
      failed_login_count  integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
      locked_until        timestamptz,
      password_changed_at timestamptz NOT NULL DEFAULT now(),
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX users_email_unique ON users (email);
    CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    -- Users referenced by financial history and audit records are disabled, not deleted.
    CREATE TRIGGER users_no_delete BEFORE DELETE ON users
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

    CREATE TABLE organization_members (
      organization_id  uuid NOT NULL REFERENCES organizations (id),
      user_id          uuid NOT NULL REFERENCES users (id),
      role             text NOT NULL CHECK (role IN ('owner', 'admin', 'finance', 'developer', 'viewer')),
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, user_id)
    );
    CREATE INDEX organization_members_user ON organization_members (user_id);
    CREATE TRIGGER organization_members_updated_at BEFORE UPDATE ON organization_members
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Every organization keeps at least one owner. Checked at COMMIT so that
    -- "promote B, then demote A" inside one transaction is allowed.
    CREATE FUNCTION organization_must_have_owner() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      org uuid := COALESCE(OLD.organization_id, NEW.organization_id);
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM organization_members WHERE organization_id = org AND role = 'owner') THEN
        RAISE EXCEPTION 'organization % must keep at least one owner', org
          USING ERRCODE = 'check_violation', CONSTRAINT = 'organization_must_have_owner';
      END IF;
      RETURN NULL;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER organization_members_keep_owner
      AFTER UPDATE OR DELETE ON organization_members DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION organization_must_have_owner();

    CREATE TABLE sessions (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id          uuid NOT NULL REFERENCES users (id),
      token_hash       text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      mfa_verified     boolean NOT NULL,
      created_at       timestamptz NOT NULL DEFAULT now(),
      last_seen_at     timestamptz NOT NULL DEFAULT now(),
      idle_expires_at  timestamptz NOT NULL,
      expires_at       timestamptz NOT NULL,
      revoked_at       timestamptz,
      revoked_reason   text CHECK (char_length(revoked_reason) <= 50),
      ip_address       inet,
      user_agent       text CHECK (char_length(user_agent) <= 512),
      CHECK (idle_expires_at <= expires_at)
    );
    CREATE INDEX sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;

    -- Short-lived single-use tokens: email verification, password reset,
    -- and the second step of an MFA login.
    CREATE TABLE auth_tokens (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      uuid NOT NULL REFERENCES users (id),
      purpose      text NOT NULL CHECK (purpose IN ('email_verification', 'password_reset', 'mfa_challenge')),
      token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      expires_at   timestamptz NOT NULL,
      consumed_at  timestamptz,
      attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX auth_tokens_user_purpose ON auth_tokens (user_id, purpose) WHERE consumed_at IS NULL;

    CREATE TABLE totp_credentials (
      user_id            uuid PRIMARY KEY REFERENCES users (id),
      secret_ciphertext  text NOT NULL,
      confirmed_at       timestamptz,
      -- Highest accepted 30-second time step: a code can be used only once.
      last_used_step     bigint,
      created_at         timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE recovery_codes (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     uuid NOT NULL REFERENCES users (id),
      code_hash   text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
      used_at     timestamptz,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX recovery_codes_user ON recovery_codes (user_id) WHERE used_at IS NULL;

    CREATE TABLE organization_invitations (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id  uuid NOT NULL REFERENCES organizations (id),
      email            text NOT NULL CHECK (email = lower(email)),
      role             text NOT NULL CHECK (role IN ('owner', 'admin', 'finance', 'developer', 'viewer')),
      token_hash       text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      invited_by       uuid NOT NULL REFERENCES users (id),
      expires_at       timestamptz NOT NULL,
      accepted_at      timestamptz,
      accepted_by      uuid REFERENCES users (id),
      revoked_at       timestamptz,
      created_at       timestamptz NOT NULL DEFAULT now(),
      CHECK (accepted_at IS NULL OR revoked_at IS NULL)
    );
    CREATE UNIQUE INDEX organization_invitations_pending
      ON organization_invitations (organization_id, email)
      WHERE accepted_at IS NULL AND revoked_at IS NULL;

    CREATE TABLE api_keys (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id     uuid NOT NULL REFERENCES organizations (id),
      -- Non-secret lookup id embedded in the key string (apk_<mode>_<public_id>_<secret>).
      public_id           text NOT NULL UNIQUE CHECK (public_id ~ '^[A-Za-z0-9]{16}$'),
      secret_hash         text NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
      name                text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
      scopes              text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 32),
      created_by          uuid NOT NULL REFERENCES users (id),
      created_at          timestamptz NOT NULL DEFAULT now(),
      expires_at          timestamptz,
      revoked_at          timestamptz,
      revoked_by          uuid REFERENCES users (id),
      last_used_at        timestamptz,
      last_used_ip        inet,
      rotated_from_id     uuid REFERENCES api_keys (id)
    );
    CREATE INDEX api_keys_org ON api_keys (organization_id, created_at DESC);
    CREATE TRIGGER api_keys_no_delete BEFORE DELETE ON api_keys
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE api_keys;
    DROP TABLE organization_invitations;
    DROP TABLE recovery_codes;
    DROP TABLE totp_credentials;
    DROP TABLE auth_tokens;
    DROP TABLE sessions;
    DROP TABLE organization_members;
    DROP FUNCTION organization_must_have_owner();
    DROP TABLE users;
  `.execute(db);
}
