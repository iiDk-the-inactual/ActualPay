/**
 * Webhook endpoints and deliveries.
 *
 * Delivery rows are created in the same transaction as the domain event they
 * announce (see recordEvent), so a webhook exists if and only if the change
 * committed; the worker only has to send what is already recorded.
 *
 * Signing secrets must be recoverable to sign, so they are stored encrypted
 * (AES-256-GCM, bound to the endpoint id), never in clear.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE webhook_endpoints (
      id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id             uuid NOT NULL REFERENCES organizations (id),
      url                         text NOT NULL CHECK (char_length(url) BETWEEN 10 AND 2000),
      description                 text CHECK (char_length(description) <= 200),
      -- Event types to receive; '*' means all.
      event_types                 text[] NOT NULL CHECK (cardinality(event_types) BETWEEN 1 AND 40),
      secret_ciphertext           text NOT NULL,
      -- After a rotation the old secret keeps signing for a grace period.
      previous_secret_ciphertext  text,
      previous_secret_expires_at  timestamptz,
      status                      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      disabled_reason             text CHECK (char_length(disabled_reason) <= 200),
      consecutive_failures        integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
      created_by_type             text NOT NULL CHECK (created_by_type IN ('user', 'api_key')),
      created_by_id               text NOT NULL CHECK (char_length(created_by_id) <= 100),
      created_at                  timestamptz NOT NULL DEFAULT now(),
      updated_at                  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT webhook_previous_pair CHECK (
        (previous_secret_ciphertext IS NULL) = (previous_secret_expires_at IS NULL))
    );
    CREATE INDEX webhook_endpoints_org ON webhook_endpoints (organization_id, created_at DESC);
    CREATE TRIGGER webhook_endpoints_updated_at BEFORE UPDATE ON webhook_endpoints
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER webhook_endpoints_no_delete BEFORE DELETE ON webhook_endpoints
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

    CREATE TABLE webhook_deliveries (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      endpoint_id      uuid NOT NULL REFERENCES webhook_endpoints (id),
      organization_id  uuid NOT NULL REFERENCES organizations (id),
      event_id         bigint NOT NULL REFERENCES domain_events (id),
      status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
      attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at  timestamptz NOT NULL DEFAULT now(),
      -- Short claim so concurrent workers do not send the same delivery.
      locked_until     timestamptz,
      last_attempt_at  timestamptz,
      last_status_code integer,
      last_error       text CHECK (char_length(last_error) <= 500),
      delivered_at     timestamptz,
      created_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT webhook_delivered_pair CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
    );
    CREATE UNIQUE INDEX webhook_deliveries_unique ON webhook_deliveries (endpoint_id, event_id);
    CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
    CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id, created_at DESC, id DESC);
    CREATE INDEX webhook_deliveries_org ON webhook_deliveries (organization_id, created_at DESC);
    CREATE TRIGGER webhook_deliveries_no_delete BEFORE DELETE ON webhook_deliveries
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    CREATE FUNCTION webhook_deliveries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id
         OR NEW.event_id IS DISTINCT FROM OLD.event_id
         OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
        RAISE EXCEPTION 'webhook delivery % identity is immutable', OLD.id USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.attempts < OLD.attempts AND NEW.status = 'pending' AND OLD.status = 'pending' THEN
        RAISE EXCEPTION 'webhook delivery % attempts cannot go backwards', OLD.id USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER webhook_deliveries_guard BEFORE UPDATE ON webhook_deliveries
      FOR EACH ROW EXECUTE FUNCTION webhook_deliveries_guard();
  `.execute(db);
}
