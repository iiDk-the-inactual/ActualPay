/**
 * Fan domain events and audit entries out to email.
 *
 * Reads past a cursor, queues one outbox row per recipient (idempotent by
 * dedupe key), and advances the cursor in the same transaction, so a crash
 * neither loses nor duplicates a notice. Meant to run under a lease so only one
 * worker does it at a time.
 */
import { inTransaction, type Db } from '@actualpay/database';
import { enqueueEmail } from './outbox';
import { noticeForAudit, noticeForEvent, renderBody, type Notice } from './messages';
import { recipientsFor } from './recipients';

export interface FanoutDeps {
  readonly db: Db;
  readonly baseUrl: string;
  readonly appName: string;
  readonly now?: Date;
  readonly batch?: number;
}

export interface FanoutSummary {
  readonly events: number;
  readonly audits: number;
  readonly queued: number;
}

export async function fanOutNotifications(deps: FanoutDeps): Promise<FanoutSummary> {
  const batch = deps.batch ?? 200;
  const now = deps.now ?? new Date();
  return inTransaction(deps.db, async (tx) => {
    const cursor = await tx
      .selectFrom('notification_cursor')
      .selectAll()
      .where('id', '=', 1)
      .forUpdate()
      .executeTakeFirstOrThrow();

    const events = await tx
      .selectFrom('domain_events')
      .selectAll()
      .where('id', '>', cursor.last_event_id)
      .orderBy('id')
      .limit(batch)
      .execute();
    const audits = await tx
      .selectFrom('audit_log')
      .selectAll()
      .where('id', '>', cursor.last_audit_id)
      .where('organization_id', 'is not', null)
      .orderBy('id')
      .limit(batch)
      .execute();
    const orgNames = new Map<string, string>();
    const nameOf = async (organizationId: string): Promise<string> => {
      const cached = orgNames.get(organizationId);
      if (cached !== undefined) return cached;
      const row = await tx
        .selectFrom('organizations')
        .select('name')
        .where('id', '=', organizationId)
        .executeTakeFirst();
      const name = row?.name ?? 'Unknown organization';
      orgNames.set(organizationId, name);
      return name;
    };

    let queued = 0;
    const deliver = async (
      organizationId: string,
      notice: Notice,
      dedupe: string,
      actor?: string,
    ): Promise<void> => {
      const recipients = await recipientsFor(tx, organizationId, notice.kind);
      if (recipients.length === 0) return;
      const body = renderBody({
        notice,
        organizationName: await nameOf(organizationId),
        baseUrl: deps.baseUrl,
        appName: deps.appName,
        ...(actor ? { actor } : {}),
      });
      for (const r of recipients) {
        const ok = await enqueueEmail(
          tx,
          {
            kind: notice.kind,
            organizationId,
            to: r.email,
            subject: `[${deps.appName}] ${notice.subject}`,
            body,
            dedupeKey: `${dedupe}:${r.email.toLowerCase()}`,
          },
          { now },
        );
        if (ok) queued += 1;
      }
    };

    for (const event of events) {
      const notice = noticeForEvent(event.type, event.payload);
      if (notice) await deliver(event.organization_id, notice, `event:${event.id}`);
    }
    for (const audit of audits) {
      if (!audit.organization_id) continue;
      const notice = noticeForAudit(audit.action, audit.metadata);
      if (!notice) continue;
      const actor =
        audit.actor_type === 'system'
          ? 'the system'
          : `${audit.actor_type}${audit.ip_address ? ` from ${audit.ip_address}` : ''}`;
      await deliver(audit.organization_id, notice, `audit:${audit.id}`, actor);
    }

    await tx
      .updateTable('notification_cursor')
      .set({
        last_event_id: events.at(-1)?.id ?? cursor.last_event_id,
        last_audit_id: audits.at(-1)?.id ?? cursor.last_audit_id,
        updated_at: now,
      })
      .where('id', '=', 1)
      .execute();
    return { events: events.length, audits: audits.length, queued };
  });
}
