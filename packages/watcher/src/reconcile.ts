/**
 * Consistency checks that run on a schedule and raise issues for humans.
 *
 * These check the platform against itself: the books, the cached invoice
 * totals, stuck payments, and whether the other workers are alive. Comparing
 * custody against actual on-chain balances needs the signer and sweep
 * accounting (Phase 8) and is not done here.
 *
 * A condition that clears resolves its own issue, so the open list always
 * means "needs attention now".
 */
import { sql } from 'kysely';
import type { Db } from '@actualpay/database';
import { verifyLedgerIntegrity } from '@actualpay/ledger';
import type { Logger } from '@actualpay/shared';
import { autoResolveIssue, openIssue } from './issues';

export const STUCK_PENDING_HOURS = 24;
export const STALE_WATCHER_MINUTES = 15;
export const EXPIRY_LAG_MINUTES = 10;

/** Resolve open issues of `kind` whose subject is no longer in `current`. */
async function resolveGone(
  db: Db,
  kind: string,
  subjectType: string,
  current: ReadonlySet<string>,
) {
  const open = await db
    .selectFrom('reconciliation_issues')
    .select('subject_id')
    .where('kind', '=', kind)
    .where('subject_type', '=', subjectType)
    .where('status', '=', 'open')
    .execute();
  for (const row of open) {
    if (!current.has(row.subject_id)) await autoResolveIssue(db, kind, subjectType, row.subject_id);
  }
}

export async function reconcileOnce(params: {
  db: Db;
  logger: Logger;
  now?: Date;
}): Promise<{ problems: number }> {
  const { db, logger } = params;
  const now = params.now ?? new Date();
  let problems = 0;

  // 1. The books.
  const report = await verifyLedgerIntegrity(db);
  if (report.ok) {
    await autoResolveIssue(db, 'ledger_integrity', 'ledger', 'global');
  } else {
    problems += 1;
    logger.error({ report }, 'ledger integrity check failed');
    await openIssue(db, {
      kind: 'ledger_integrity',
      severity: 'critical',
      subjectType: 'ledger',
      subjectId: 'global',
      summary: 'The ledger failed its integrity check. Stop moving money until this is understood.',
      details: {
        balanceMismatches: report.balanceMismatches.length,
        unbalancedJournals: report.unbalancedJournals.length,
        solvencyGaps: report.solvencyGaps.map((g) => ({ assetId: g.assetId, gap: g.gap })),
      },
    });
  }

  // 2. Cached invoice totals must equal the sum of their payments.
  const drifted = await db
    .selectFrom('invoices as i')
    .select(['i.id', 'i.organization_id', 'i.amount_confirmed', 'i.amount_pending'])
    .where((eb) =>
      eb.or([
        eb(
          'i.amount_confirmed',
          '<>',
          sql<string>`COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id AND p.counts_toward_invoice AND p.status = 'confirmed'), 0)`,
        ),
        eb(
          'i.amount_pending',
          '<>',
          sql<string>`COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id AND p.counts_toward_invoice AND p.status = 'pending'), 0)`,
        ),
      ]),
    )
    .limit(100)
    .execute();
  for (const row of drifted) {
    problems += 1;
    await openIssue(db, {
      kind: 'invoice_totals_mismatch',
      severity: 'critical',
      subjectType: 'invoice',
      subjectId: row.id,
      organizationId: row.organization_id,
      summary: "An invoice's cached totals differ from the sum of its payments.",
      details: { confirmed: row.amount_confirmed, pending: row.amount_pending },
    });
  }
  await resolveGone(db, 'invoice_totals_mismatch', 'invoice', new Set(drifted.map((r) => r.id)));

  // 3. Payments stuck in `pending`.
  const stuck = await db
    .selectFrom('payments')
    .select(['ref', 'organization_id'])
    .where('status', '=', 'pending')
    .where('detected_at', '<', new Date(now.getTime() - STUCK_PENDING_HOURS * 3_600_000))
    .limit(100)
    .execute();
  for (const row of stuck) {
    problems += 1;
    await openIssue(db, {
      kind: 'payment_stuck_pending',
      severity: 'warning',
      subjectType: 'payment',
      subjectId: row.ref,
      organizationId: row.organization_id,
      summary: `A payment has been unconfirmed for over ${STUCK_PENDING_HOURS} hours.`,
    });
  }
  await resolveGone(db, 'payment_stuck_pending', 'payment', new Set(stuck.map((r) => r.ref)));

  // 4. Watchers that stopped scanning.
  const stale = await db
    .selectFrom('chain_cursors')
    .select(['chain', 'network', 'scanned_at'])
    .where((eb) =>
      eb.or([
        eb('scanned_at', 'is', null),
        eb('scanned_at', '<', new Date(now.getTime() - STALE_WATCHER_MINUTES * 60_000)),
      ]),
    )
    .execute();
  for (const row of stale) {
    problems += 1;
    await openIssue(db, {
      kind: 'watcher_stale',
      severity: 'critical',
      subjectType: 'chain',
      subjectId: row.chain,
      summary: `Nothing has scanned ${row.chain} for over ${STALE_WATCHER_MINUTES} minutes. Payments there are not being seen.`,
      details: { lastScan: row.scanned_at?.toISOString() ?? null },
    });
  }
  await resolveGone(db, 'watcher_stale', 'chain', new Set(stale.map((r) => r.chain)));

  // 5. Expiry sweep not running.
  const lagging = await db
    .selectFrom('invoices')
    .select(sql<string>`count(*)`.as('n'))
    .where('status', 'in', ['open', 'partially_paid'])
    .where('expires_at', '<', new Date(now.getTime() - EXPIRY_LAG_MINUTES * 60_000))
    .executeTakeFirstOrThrow();
  if (Number(lagging.n) > 0) {
    problems += 1;
    await openIssue(db, {
      kind: 'expiry_lagging',
      severity: 'warning',
      subjectType: 'invoices',
      subjectId: 'expiry',
      summary: `${lagging.n} invoices are past their expiry but still marked unpaid.`,
    });
  } else {
    await autoResolveIssue(db, 'expiry_lagging', 'invoices', 'expiry');
  }
  return { problems };
}
