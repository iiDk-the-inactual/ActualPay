/**
 * Audit log and API idempotency records.
 *
 * audit_log is append-only. Actor ids are stored as text without a foreign
 * key on purpose: the audit trail must outlive the users, API keys and
 * sessions it describes.
 *
 * idempotency_keys backs the `Idempotency-Key` header. The unique constraint
 * is what makes concurrent retries safe; the middleware (Phase 2) only
 * interprets the row it wins or finds.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE audit_log (
      id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      occurred_at      timestamptz NOT NULL DEFAULT now(),
      actor_type       text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
      actor_id         text CHECK (char_length(actor_id) <= 100),
      organization_id  uuid REFERENCES organizations (id),
      action           text NOT NULL CHECK (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
      target_type      text CHECK (char_length(target_type) <= 50),
      target_id        text CHECK (char_length(target_id) <= 100),
      request_id       text CHECK (char_length(request_id) <= 100),
      ip_address       inet,
      user_agent       text CHECK (char_length(user_agent) <= 512),
      metadata         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
      CONSTRAINT audit_log_actor CHECK ((actor_type = 'system') OR actor_id IS NOT NULL)
    );

    CREATE INDEX audit_log_org_time ON audit_log (organization_id, occurred_at DESC);
    CREATE INDEX audit_log_action_time ON audit_log (action, occurred_at DESC);
    CREATE INDEX audit_log_actor ON audit_log (actor_type, actor_id, occurred_at DESC);

    CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
      FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

    CREATE TABLE idempotency_keys (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id  uuid NOT NULL REFERENCES organizations (id),
      scope            text NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 100),
      key              text NOT NULL CHECK (key ~ '^[A-Za-z0-9_.:-]{1,255}$'),
      request_hash     text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
      state            text NOT NULL DEFAULT 'in_progress' CHECK (state IN ('in_progress', 'completed')),
      response_status  integer CHECK (response_status BETWEEN 100 AND 599),
      response_body    jsonb,
      locked_until     timestamptz,
      created_at       timestamptz NOT NULL DEFAULT now(),
      expires_at       timestamptz NOT NULL,
      UNIQUE (organization_id, scope, key),
      CONSTRAINT idempotency_completed_has_response CHECK (
        (state = 'completed') = (response_status IS NOT NULL))
    );

    CREATE INDEX idempotency_keys_expiry ON idempotency_keys (expires_at);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE idempotency_keys;
    DROP TABLE audit_log;
  `.execute(db);
}
