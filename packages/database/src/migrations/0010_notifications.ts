/**
 * Email notifications.
 *
 * `email_outbox` holds mail waiting to be sent (never one-time links: those go
 * out directly and are not stored). `dedupe_key` makes enqueueing idempotent, so
 * a crash or a second worker cannot send the same notice twice. Per-user
 * preferences and verified forwarding addresses decide who is told what. A
 * forward must be confirmed by the address owner before it receives anything,
 * so nobody can use the system to spam a third party.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE notification_preferences (
      user_id          uuid NOT NULL REFERENCES users (id),
      organization_id  uuid NOT NULL REFERENCES organizations (id),
      kind             text NOT NULL CHECK (kind IN ('payments', 'payment_problems', 'withdrawals', 'security', 'webhooks')),
      enabled          boolean NOT NULL,
      updated_at       timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, organization_id, kind)
    );
    CREATE TRIGGER notification_preferences_updated_at BEFORE UPDATE ON notification_preferences
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE notification_forwards (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations (id),
      email             text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254 AND email = lower(email)),
      kinds             text[] NOT NULL CHECK (cardinality(kinds) BETWEEN 1 AND 5),
      status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'removed')),
      -- Only a hash of the verification token is stored.
      token_hash        text CHECK (char_length(token_hash) = 64),
      token_expires_at  timestamptz,
      verified_at       timestamptz,
      created_by        uuid NOT NULL REFERENCES users (id),
      created_at        timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT forward_active_verified CHECK ((status = 'active') = (verified_at IS NOT NULL) OR status = 'removed')
    );
    CREATE UNIQUE INDEX notification_forwards_unique
      ON notification_forwards (organization_id, email) WHERE status <> 'removed';
    CREATE UNIQUE INDEX notification_forwards_token ON notification_forwards (token_hash)
      WHERE token_hash IS NOT NULL;

    -- Progress of the fan-out over domain_events and audit_log (single row).
    CREATE TABLE notification_cursor (
      id               smallint PRIMARY KEY CHECK (id = 1),
      last_event_id    bigint NOT NULL DEFAULT 0,
      last_audit_id    bigint NOT NULL DEFAULT 0,
      updated_at       timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO notification_cursor (id, last_event_id, last_audit_id)
      SELECT 1, COALESCE((SELECT max(id) FROM domain_events), 0), COALESCE((SELECT max(id) FROM audit_log), 0);

    CREATE TABLE email_outbox (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind             text NOT NULL CHECK (char_length(kind) <= 40),
      organization_id  uuid REFERENCES organizations (id),
      to_address       text NOT NULL CHECK (char_length(to_address) BETWEEN 3 AND 254),
      subject          text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200 AND subject !~ '[\\r\\n]'),
      body             text NOT NULL CHECK (char_length(body) <= 5000),
      dedupe_key       text NOT NULL UNIQUE CHECK (char_length(dedupe_key) <= 300),
      status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
      attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at  timestamptz NOT NULL DEFAULT now(),
      locked_until     timestamptz,
      last_error       text CHECK (char_length(last_error) <= 200),
      created_at       timestamptz NOT NULL DEFAULT now(),
      sent_at          timestamptz,
      CONSTRAINT outbox_sent_pair CHECK ((status = 'sent') = (sent_at IS NOT NULL))
    );
    CREATE INDEX email_outbox_due ON email_outbox (next_attempt_at) WHERE status = 'pending';
    CREATE INDEX email_outbox_org_day ON email_outbox (organization_id, created_at);
  `.execute(db);
}
