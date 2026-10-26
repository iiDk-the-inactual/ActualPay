/**
 * Reconciliation issues: things a human must look at.
 *
 * Opening the same issue again bumps a counter instead of piling up rows, and
 * issues that detection can prove are gone resolve themselves. Everything else
 * stays open until an operator resolves it with a note (audited).
 */
import { sql } from 'kysely';
import {
  inTransaction,
  type Db,
  type IssueSeverity,
  type ReconciliationIssueRow,
} from '@actualpay/database';
import { recordAudit, type RequestMeta } from '@actualpay/audit';
import { AppError } from '@actualpay/shared';

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

export async function resolveIssue(
  db: Db,
  params: { issueId: string; userId: string; note: string },
  meta: RequestMeta,
): Promise<ReconciliationIssueRow> {
  const note = params.note.trim();
  if (note.length < 3 || note.length > 2000)
    throw AppError.validation('A resolution note of 3–2000 characters is required.');
  return inTransaction(db, async (tx) => {
    const row = await tx
      .updateTable('reconciliation_issues')
      .set({
        status: 'resolved',
        resolved_at: sql<Date>`now()`,
        resolved_by: params.userId,
        resolution_note: note,
      })
      .where('id', '=', params.issueId)
      .where('status', '=', 'open')
      .returningAll()
      .executeTakeFirst();
    if (!row) throw AppError.notFound('Open issue');
    await recordAudit(tx, {
      actor: { type: 'user', id: params.userId },
      action: 'reconciliation.issue_resolved',
      organizationId: row.organization_id,
      target: { type: 'reconciliation_issue', id: row.id },
      meta,
      metadata: { kind: row.kind, subjectId: row.subject_id },
    });
    return row;
  });
}

export async function listIssues(
  db: Db,
  options: { status?: 'open' | 'resolved'; limit?: number } = {},
): Promise<ReconciliationIssueRow[]> {
  let query = db.selectFrom('reconciliation_issues').selectAll();
  if (options.status) query = query.where('status', '=', options.status);
  return query
    .orderBy('severity', 'desc')
    .orderBy('last_seen_at', 'desc')
    .limit(options.limit ?? 200)
    .execute();
}
