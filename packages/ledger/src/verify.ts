/**
 * Internal ledger integrity checks (the blockchain-vs-ledger comparison is
 * part of reconciliation in Phase 6). These are read-only and report
 * problems; they never correct anything.
 */
import { sql } from 'kysely';
import type { Db } from '@actualpay/database';

export interface LedgerIntegrityReport {
  /** Accounts whose cached balance differs from the sum of their entries. */
  readonly balanceMismatches: ReadonlyArray<{
    accountId: string;
    cached: bigint;
    computed: bigint;
  }>;
  /** Journals that do not balance per asset (should be impossible). */
  readonly unbalancedJournals: ReadonlyArray<{ journalId: string; assetId: string }>;
  /** Per-asset custody vs obligations; non-zero means books are inconsistent. */
  readonly solvencyGaps: ReadonlyArray<{ assetId: string; gap: bigint }>;
  readonly ok: boolean;
}

export async function verifyLedgerIntegrity(db: Db): Promise<LedgerIntegrityReport> {
  const mismatches = await sql<{ account_id: string; cached: string; computed: string }>`
    SELECT a.id AS account_id, a.balance::text AS cached,
           COALESCE(SUM(CASE WHEN e.direction = a.normal_side THEN e.amount ELSE -e.amount END), 0)::text AS computed
    FROM ledger_accounts a
    LEFT JOIN ledger_entries e ON e.account_id = a.id
    GROUP BY a.id
    HAVING a.balance <> COALESCE(SUM(CASE WHEN e.direction = a.normal_side THEN e.amount ELSE -e.amount END), 0)
  `.execute(db);

  const unbalanced = await sql<{ journal_id: string; asset_id: string }>`
    SELECT journal_id, asset_id FROM ledger_entries
    GROUP BY journal_id, asset_id
    HAVING SUM(CASE direction WHEN 'debit' THEN amount ELSE -amount END) <> 0
  `.execute(db);

  // Debit-normal balances count positive, credit-normal negative: in a
  // consistent double-entry book the total is zero for every asset.
  const solvency = await sql<{ asset_id: string; gap: string }>`
    SELECT asset_id,
           SUM(CASE normal_side WHEN 'debit' THEN balance ELSE -balance END)::text AS gap
    FROM ledger_accounts
    GROUP BY asset_id
    HAVING SUM(CASE normal_side WHEN 'debit' THEN balance ELSE -balance END) <> 0
  `.execute(db);

  const report = {
    balanceMismatches: mismatches.rows.map((r) => ({
      accountId: r.account_id,
      cached: BigInt(r.cached),
      computed: BigInt(r.computed),
    })),
    unbalancedJournals: unbalanced.rows.map((r) => ({
      journalId: r.journal_id,
      assetId: r.asset_id,
    })),
    solvencyGaps: solvency.rows.map((r) => ({ assetId: r.asset_id, gap: BigInt(r.gap) })),
  };
  return {
    ...report,
    ok:
      report.balanceMismatches.length === 0 &&
      report.unbalancedJournals.length === 0 &&
      report.solvencyGaps.length === 0,
  };
}
