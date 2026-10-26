import { sql } from 'kysely';
import type { Db, NotificationKind, Tx } from '@actualpay/database';
import { KIND_INFO } from './kinds';

export interface Recipient {
  readonly email: string;
  /** Present for members, absent for forwarding addresses. */
  readonly userId?: string;
}

/**
 * Who should hear about `kind` in an organization: members whose role is
 * eligible and who have not switched it off (or have switched it on), plus
 * verified forwarding addresses that subscribed to it. Disabled accounts and
 * unverified emails are never mailed. De-duplicated and capped.
 */
export async function recipientsFor(
  db: Db | Tx,
  organizationId: string,
  kind: NotificationKind,
): Promise<Recipient[]> {
  const info = KIND_INFO[kind];
  const members = await db
    .selectFrom('organization_members as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .leftJoin('notification_preferences as p', (join) =>
      join
        .onRef('p.user_id', '=', 'm.user_id')
        .onRef('p.organization_id', '=', 'm.organization_id')
        .on('p.kind', '=', kind),
    )
    .select(['u.id as userId', 'u.email as email', 'p.enabled as enabled'])
    .where('m.organization_id', '=', organizationId)
    .where('m.role', 'in', [...info.roles])
    .where('u.status', '=', 'active')
    .where('u.email_verified_at', 'is not', null)
    .execute();

  const out = new Map<string, Recipient>();
  for (const row of members) {
    const on = row.enabled ?? info.defaultOn;
    if (on) out.set(row.email.toLowerCase(), { email: row.email, userId: row.userId });
  }

  const forwards = await db
    .selectFrom('notification_forwards')
    .select('email')
    .where('organization_id', '=', organizationId)
    .where('status', '=', 'active')
    .where(sql<boolean>`kinds @> ARRAY[${kind}]::text[]`)
    .execute();
  for (const row of forwards) if (!out.has(row.email)) out.set(row.email, { email: row.email });

  return [...out.values()].slice(0, 60);
}
