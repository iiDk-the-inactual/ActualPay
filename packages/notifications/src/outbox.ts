/**
 * The email outbox: enqueue idempotently, send with retries.
 *
 * Email is best-effort and never on a money path. Rows are claimed with
 * FOR UPDATE SKIP LOCKED, so several workers can run; a lost claim simply
 * expires. Provider error text is never stored (it can echo addresses); only a
 * fixed phrase is.
 */
import { sql } from 'kysely';
import type { Db, Tx } from '@actualpay/database';
import type { Mailer } from '@actualpay/email';
import type { Logger } from '@actualpay/shared';

export const MAX_ATTEMPTS = 8;
/** Non-security mail per organization per rolling day; a backstop against floods. */
export const DAILY_ORG_CAP = 300;
const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21_600, 43_200, 86_400];

export interface OutgoingEmail {
  readonly kind: string;
  readonly organizationId: string | null;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly dedupeKey: string;
}

/** Returns true if a new row was queued, false if it was a duplicate or capped. */
export async function enqueueEmail(
  db: Db | Tx,
  email: OutgoingEmail,
  options: { now?: Date; enforceCap?: boolean } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  if (options.enforceCap !== false && email.organizationId) {
    const recent = await db
      .selectFrom('email_outbox')
      .select(sql<string>`count(*)`.as('n'))
      .where('organization_id', '=', email.organizationId)
      .where('created_at', '>', new Date(now.getTime() - 86_400_000))
      .executeTakeFirstOrThrow();
    if (Number(recent.n) >= DAILY_ORG_CAP) return false;
  }
  const inserted = await db
    .insertInto('email_outbox')
    .values({
      kind: email.kind,
      organization_id: email.organizationId,
      to_address: email.to,
      subject: email.subject.replace(/[\r\n]+/g, ' ').slice(0, 200),
      body: email.body.slice(0, 5000),
      dedupe_key: email.dedupeKey.slice(0, 300),
      next_attempt_at: now,
    })
    .onConflict((oc) => oc.column('dedupe_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  return inserted !== undefined;
}

export interface SendSummary {
  readonly sent: number;
  readonly retried: number;
  readonly failed: number;
}

export async function sendDue(params: {
  db: Db;
  mailer: Mailer;
  logger: Logger;
  now?: Date;
  batch?: number;
}): Promise<SendSummary> {
  const { db, mailer, logger } = params;
  const now = params.now ?? new Date();
  const claimed = await db
    .updateTable('email_outbox')
    .set({
      locked_until: new Date(now.getTime() + 120_000),
      attempts: sql<number>`attempts + 1`,
    })
    .where(
      'id',
      'in',
      db
        .selectFrom('email_outbox')
        .select('id')
        .where('status', '=', 'pending')
        .where('next_attempt_at', '<=', now)
        .where((eb) => eb.or([eb('locked_until', 'is', null), eb('locked_until', '<', now)]))
        .orderBy('next_attempt_at')
        .limit(params.batch ?? 25)
        .forUpdate()
        .skipLocked(),
    )
    .returningAll()
    .execute();

  let sent = 0;
  let retried = 0;
  let failed = 0;
  for (const row of claimed) {
    try {
      await mailer.send({ to: row.to_address, subject: row.subject, text: row.body });
      await db
        .updateTable('email_outbox')
        .set({ status: 'sent', sent_at: now, locked_until: null, last_error: null })
        .where('id', '=', row.id)
        .execute();
      sent += 1;
    } catch (error) {
      // Log the id and kind only: the message may contain addresses and links.
      logger.warn({ outboxId: row.id, kind: row.kind, err: error }, 'email send failed');
      const exhausted = row.attempts >= MAX_ATTEMPTS;
      const delay =
        BACKOFF_SECONDS[Math.min(row.attempts - 1, BACKOFF_SECONDS.length - 1)] ?? 86_400;
      await db
        .updateTable('email_outbox')
        .set({
          status: exhausted ? 'failed' : 'pending',
          next_attempt_at: new Date(now.getTime() + delay * 1000),
          locked_until: null,
          last_error: 'delivery failed',
        })
        .where('id', '=', row.id)
        .execute();
      if (exhausted) failed += 1;
      else retried += 1;
    }
  }
  return { sent, retried, failed };
}
