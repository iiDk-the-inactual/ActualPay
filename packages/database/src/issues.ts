/**
 * Reconciliation issues: things a human must look at.
 *
 * Opening the same issue again bumps a counter instead of piling up rows, and
 * issues that detection can prove are gone resolve themselves. These two
 * helpers live here (not in the watcher) so every component can raise one.
 */
import { sql } from 'kysely';
import type { Db } from './client';
import type { IssueSeverity } from './schema';

export async function openIssue(
  db: Db,
  issue: {
    kind: string;
    severity: IssueSeverity;
    subjectType: string;
    subjectId: string;
    summary: string;
    organizationId?: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  const details = JSON.stringify(issue.details ?? {}, (_k, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
  await db
    .insertInto('reconciliation_issues')
    .values({
      kind: issue.kind,
      severity: issue.severity,
      subject_type: issue.subjectType,
      subject_id: issue.subjectId.slice(0, 255),
      organization_id: issue.organizationId ?? null,
      summary: issue.summary.slice(0, 500),
      details,
    })
    .onConflict((oc) =>
      oc
        .columns(['kind', 'subject_type', 'subject_id'])
        .where('status', '=', 'open')
        .doUpdateSet({
          occurrences: sql<number>`reconciliation_issues.occurrences + 1`,
          last_seen_at: sql<Date>`now()`,
          details,
          severity: issue.severity,
        }),
    )
    .execute();
}

/** Close an open issue that detection has proven is gone. */
export async function autoResolveIssue(
  db: Db,
  kind: string,
  subjectType: string,
  subjectId: string,
  note = 'Resolved automatically: the condition no longer holds.',
): Promise<void> {
  await db
    .updateTable('reconciliation_issues')
    .set({ status: 'resolved', resolved_at: sql<Date>`now()`, resolution_note: note })
    .where('kind', '=', kind)
    .where('subject_type', '=', subjectType)
    .where('subject_id', '=', subjectId)
    .where('status', '=', 'open')
    .execute();
}
