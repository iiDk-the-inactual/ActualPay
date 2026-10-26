/**
 * Operator alerts: critical reconciliation issues and disabled webhook
 * endpoints. Queued once per issue (dedupe key), so a persistent problem does
 * not email every cycle; the dashboard keeps showing it until resolved.
 */
import type { Db } from '@actualpay/database';
import { enqueueEmail } from './outbox';
import { recipientsFor } from './recipients';

export async function alertCriticalIssues(params: {
  db: Db;
  operatorEmail: string | undefined;
  appName: string;
  baseUrl: string;
  now?: Date;
}): Promise<number> {
  if (!params.operatorEmail) return 0;
  const issues = await params.db
    .selectFrom('reconciliation_issues')
    .select(['id', 'kind', 'summary', 'organization_id'])
    .where('status', '=', 'open')
    .where('severity', '=', 'critical')
    .orderBy('first_seen_at')
    .limit(50)
    .execute();
  let queued = 0;
  for (const issue of issues) {
    const link = new URL('/app/#/admin', params.baseUrl).toString();
    const ok = await enqueueEmail(
      params.db,
      {
        kind: 'operator_alert',
        organizationId: null,
        to: params.operatorEmail,
        subject: `[${params.appName}] CRITICAL: needs attention (${issue.kind})`.slice(0, 200),
        body: [
          'A critical issue is open and may involve money. It needs a human.',
          '',
          `Kind: ${issue.kind}`,
          `Summary: ${issue.summary.replace(/[\r\n]+/g, ' ').slice(0, 400)}`,
          '',
          `Open the admin view: ${link}`,
          '',
        ].join('\n'),
        dedupeKey: `issue:${issue.id}`,
      },
      { now: params.now ?? new Date(), enforceCap: false },
    );
    if (ok) queued += 1;
  }
  return queued;
}

/** Tell the organization about endpoints that were switched off. */
export async function alertDisabledWebhooks(params: {
  db: Db;
  appName: string;
  baseUrl: string;
  now?: Date;
}): Promise<number> {
  const endpoints = await params.db
    .selectFrom('webhook_endpoints as e')
    .innerJoin('organizations as o', 'o.id', 'e.organization_id')
    .select(['e.id as id', 'e.organization_id as organizationId', 'e.url as url', 'o.name as org'])
    .where('e.status', '=', 'disabled')
    .limit(100)
    .execute();
  let queued = 0;
  for (const e of endpoints) {
    const recipients = await recipientsFor(params.db, e.organizationId, 'webhooks');
    for (const r of recipients) {
      const ok = await enqueueEmail(
        params.db,
        {
          kind: 'webhooks',
          organizationId: e.organizationId,
          to: r.email,
          subject: `[${params.appName}] A webhook endpoint was disabled`,
          body: [
            'Organization:',
            `  ${e.org.replace(/[\r\n]+/g, ' ').slice(0, 100)}`,
            '',
            'An endpoint was disabled after repeated failures, so events are no longer delivered to it.',
            `Endpoint: ${e.url.replace(/[\r\n]+/g, ' ').slice(0, 200)}`,
            '',
            `Open the dashboard: ${new URL('/app/#/webhooks', params.baseUrl).toString()}`,
            '',
          ].join('\n'),
          dedupeKey: `webhook-disabled:${e.id}:${r.email.toLowerCase()}`,
        },
        { now: params.now ?? new Date() },
      );
      if (ok) queued += 1;
    }
  }
  return queued;
}
