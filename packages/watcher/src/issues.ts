/**
 * Resolving and listing reconciliation issues. Opening and auto-resolving live in
 * the database package so every component can raise an issue.
 */
import { sql } from 'kysely';
import { inTransaction, type Db, type ReconciliationIssueRow } from '@actualpay/database';
import { recordAudit, type RequestMeta } from '@actualpay/audit';
import { AppError } from '@actualpay/shared';

export { autoResolveIssue, openIssue } from '@actualpay/database';

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
