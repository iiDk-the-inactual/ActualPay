/**
 * Posting journals: the only way money moves in ActualPay's books.
 *
 * `postJournal` must be called inside a database transaction that also
 * contains the business-state change it accounts for (e.g. marking an
 * invoice CONFIRMED). Either both commit or neither does.
 */
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { AppError } from '@actualpay/shared';
import {
  asPgError,
  PG_ERRORS,
  type JournalKind,
  type LedgerDirection,
  type Tx,
} from '@actualpay/database';
import { balanceDelta, toAccount, type LedgerAccount } from './accounts';

export interface JournalLine {
  readonly accountId: string;
  readonly direction: LedgerDirection;
  readonly amount: bigint;
}

export interface JournalInput {
  /**
   * Globally unique, deterministic reference for the real-world event,
   * e.g. `deposit:btc:<txid>:<vout>` or `withdrawal:<id>:hold`. Posting the
   * same reference twice is a no-op, which is what makes event processing
   * safe to retry and impossible to double-credit.
   */
  readonly externalRef: string;
  readonly kind: JournalKind;
  /** Owning organization; null for platform-only journals (fees, sweeps). */
  readonly organizationId: string | null;
  readonly lines: readonly JournalLine[];
  readonly reversesJournalId?: string;
  readonly description?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface PostResult {
  readonly journalId: string;
  /** False when an identical journal with this externalRef already existed. */
  readonly created: boolean;
}

function mustGet<V>(map: ReadonlyMap<string, V>, key: string): V {
  const value = map.get(key);
  if (value === undefined)
    throw new AppError('INTERNAL', 'Journal references an unknown ledger account.');
  return value;
}

const EXTERNAL_REF_PATTERN = /^[A-Za-z0-9_.:\-/]{1,255}$/;

/** Structural validation that needs no database access. */
export function validateJournalShape(input: JournalInput): void {
  if (!EXTERNAL_REF_PATTERN.test(input.externalRef)) {
    throw new AppError('INTERNAL', 'Invalid ledger external reference.');
  }
  if (input.lines.length < 2) {
    throw new AppError('LEDGER_UNBALANCED', 'A journal needs at least two lines.');
  }
  for (const line of input.lines) {
    if (typeof line.amount !== 'bigint' || line.amount <= 0n) {
      throw new AppError('LEDGER_UNBALANCED', 'Journal line amounts must be positive bigints.');
    }
  }
  if ((input.kind === 'reversal') !== (input.reversesJournalId !== undefined)) {
    throw new AppError('INTERNAL', 'Only reversal journals may reference a reversed journal.');
  }
}

/**
 * Deterministic hash of what the journal *does*. Line order does not matter;
 * descriptions and metadata are excluded because they do not move money.
 */
export function journalContentHash(input: JournalInput): string {
  const lines = input.lines
    .map((line) => `${line.accountId}|${line.direction}|${line.amount.toString()}`)
    .sort();
  const canonical = JSON.stringify({
    kind: input.kind,
    organizationId: input.organizationId,
    reversesJournalId: input.reversesJournalId ?? null,
    lines,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Per-asset debit/credit equality, given each line's account. */
export function assertBalanced(
  lines: readonly JournalLine[],
  accounts: ReadonlyMap<string, LedgerAccount>,
): void {
  const totals = new Map<string, bigint>();
  for (const line of lines) {
    const account = accounts.get(line.accountId);
    if (!account) throw new AppError('INTERNAL', 'Journal references an unknown ledger account.');
    const signed = line.direction === 'debit' ? line.amount : -line.amount;
    totals.set(account.assetId, (totals.get(account.assetId) ?? 0n) + signed);
  }
  for (const [assetId, total] of totals) {
    if (total !== 0n) {
      throw new AppError('LEDGER_UNBALANCED', 'Journal does not balance.', {
        details: { assetId },
      });
    }
  }
}

export async function postJournal(tx: Tx, input: JournalInput): Promise<PostResult> {
  validateJournalShape(input);
  const contentHash = journalContentHash(input);

  // 1. Claim the external reference. A concurrent poster of the same ref
  //    blocks here until we commit or roll back, then sees our row.
  const inserted = await tx
    .insertInto('ledger_journals')
    .values({
      external_ref: input.externalRef,
      kind: input.kind,
      organization_id: input.organizationId,
      content_hash: contentHash,
      reverses_journal_id: input.reversesJournalId ?? null,
      description: input.description ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
    })
    .onConflict((oc) => oc.column('external_ref').doNothing())
    .returning('id')
    .executeTakeFirst();

  if (!inserted) {
    const existing = await tx
      .selectFrom('ledger_journals')
      .select(['id', 'content_hash'])
      .where('external_ref', '=', input.externalRef)
      .executeTakeFirstOrThrow();
    if (existing.content_hash !== contentHash) {
      // Same event reference, different money movement: never "fix" this
      // automatically. It indicates a logic bug or tampering.
      throw new AppError('CONFLICT', 'A different journal already exists for this reference.', {
        details: { externalRef: input.externalRef },
      });
    }
    return { journalId: existing.id, created: false };
  }

  // 2. Lock every touched account in a stable order (by id) so concurrent
  //    journals touching overlapping accounts cannot deadlock.
  const accountIds = [...new Set(input.lines.map((line) => line.accountId))].sort();
  const rows = await tx
    .selectFrom('ledger_accounts')
    .selectAll()
    .where('id', 'in', accountIds)
    .orderBy('id')
    .forUpdate()
    .execute();
  const accounts = new Map(rows.map((row) => [row.id, toAccount(row)]));
  if (accounts.size !== accountIds.length) {
    throw new AppError('INTERNAL', 'Journal references an unknown ledger account.');
  }

  // 3. Tenant isolation: organization accounts may only appear in that
  //    organization's journals. Platform accounts may appear in any.
  for (const account of accounts.values()) {
    if (account.organizationId !== null && account.organizationId !== input.organizationId) {
      throw new AppError('FORBIDDEN', "Journal touches another organization's account.");
    }
  }

  assertBalanced(input.lines, accounts);

  // 4. Compute resulting balances under the lock and fail cleanly before
  //    the database CHECK constraint has to.
  const deltas = new Map<string, bigint>();
  for (const line of input.lines) {
    const account = mustGet(accounts, line.accountId);
    deltas.set(
      line.accountId,
      (deltas.get(line.accountId) ?? 0n) +
        balanceDelta(account.normalSide, line.direction, line.amount),
    );
  }
  for (const [accountId, delta] of deltas) {
    const account = mustGet(accounts, accountId);
    if (!account.allowNegative && account.balance + delta < 0n) {
      throw new AppError(
        'INSUFFICIENT_BALANCE',
        'The available balance is insufficient for this operation.',
        {
          details: { accountType: account.type, assetId: account.assetId },
        },
      );
    }
  }

  // 5. Write entries and move cached balances.
  await tx
    .insertInto('ledger_entries')
    .values(
      input.lines.map((line) => ({
        journal_id: inserted.id,
        account_id: line.accountId,
        asset_id: mustGet(accounts, line.accountId).assetId,
        direction: line.direction,
        amount: line.amount.toString(),
      })),
    )
    .execute();

  try {
    for (const [accountId, delta] of deltas) {
      if (delta === 0n) continue;
      await tx
        .updateTable('ledger_accounts')
        .set({ balance: sql<string>`balance + ${delta.toString()}::numeric` })
        .where('id', '=', accountId)
        .execute();
    }
  } catch (error) {
    const pg = asPgError(error);
    if (
      pg?.code === PG_ERRORS.CHECK_VIOLATION &&
      pg.constraint === 'ledger_accounts_non_negative'
    ) {
      throw new AppError(
        'INSUFFICIENT_BALANCE',
        'The available balance is insufficient for this operation.',
        { cause: error },
      );
    }
    throw error;
  }

  return { journalId: inserted.id, created: true };
}

/**
 * Post the exact mirror of an existing journal. This is the only way to
 * "undo" money movement; the original stays in the history.
 */
export async function reverseJournal(
  tx: Tx,
  params: {
    journalId: string;
    externalRef: string;
    description?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<PostResult> {
  const original = await tx
    .selectFrom('ledger_journals')
    .select(['id', 'kind', 'organization_id'])
    .where('id', '=', params.journalId)
    .executeTakeFirst();
  if (!original) throw AppError.notFound('Ledger journal');
  if (original.kind === 'reversal') {
    throw new AppError(
      'INVALID_STATE_TRANSITION',
      'A reversal cannot itself be reversed; post an adjustment instead.',
    );
  }
  const existingReversal = await tx
    .selectFrom('ledger_journals')
    .select(['external_ref'])
    .where('reverses_journal_id', '=', original.id)
    .executeTakeFirst();
  if (existingReversal && existingReversal.external_ref !== params.externalRef) {
    throw new AppError('INVALID_STATE_TRANSITION', 'This journal has already been reversed.');
  }
  const entries = await tx
    .selectFrom('ledger_entries')
    .select(['account_id', 'direction', 'amount'])
    .where('journal_id', '=', params.journalId)
    .execute();

  return postJournal(tx, {
    externalRef: params.externalRef,
    kind: 'reversal',
    organizationId: original.organization_id,
    reversesJournalId: original.id,
    lines: entries.map((entry) => ({
      accountId: entry.account_id,
      direction: entry.direction === 'debit' ? 'credit' : 'debit',
      amount: BigInt(entry.amount),
    })),
    ...(params.description !== undefined ? { description: params.description } : {}),
    ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
  });
}
