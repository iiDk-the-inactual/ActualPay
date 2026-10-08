import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@actualpay/shared';
import { inTransaction, type Db } from '@actualpay/database';
import {
  ensureAccount,
  postConfirmedDeposit,
  postJournal,
  postWithdrawalHold,
  postWithdrawalRelease,
  postWithdrawalSettled,
  reverseJournal,
  verifyLedgerIntegrity,
} from '@actualpay/ledger';
import { createOrganization, createTestDb, resetDatabase } from './helpers';

let db: Db;
let orgId: string;

async function available(organizationId: string, assetId: string): Promise<bigint> {
  return inTransaction(
    db,
    async (tx) =>
      (await ensureAccount(tx, { organizationId, assetId, type: 'org_available' })).balance,
  );
}

async function platform(
  assetId: string,
  type: 'custody' | 'network_fees' | 'platform_revenue',
): Promise<bigint> {
  return inTransaction(
    db,
    async (tx) => (await ensureAccount(tx, { organizationId: null, assetId, type })).balance,
  );
}

async function expectLedgerConsistent(): Promise<void> {
  const report = await verifyLedgerIntegrity(db);
  expect(report).toMatchObject({
    balanceMismatches: [],
    unbalancedJournals: [],
    solvencyGaps: [],
    ok: true,
  });
}

beforeAll(async () => {
  db = createTestDb();
  await resetDatabase(db);
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  orgId = await createOrganization(db);
});

describe('deposits', () => {
  it('credits a confirmed deposit exactly once, however many times it is posted', async () => {
    const post = () =>
      inTransaction(db, (tx) =>
        postConfirmedDeposit(tx, {
          organizationId: orgId,
          assetId: 'btc',
          amount: 150_000_000n,
          depositRef: `btc:${orgId}:0`,
        }),
      );

    const first = await post();
    const second = await post();
    expect(first.created).toBe(true);
    expect(second).toEqual({ journalId: first.journalId, created: false });
    expect(await available(orgId, 'btc')).toBe(150_000_000n);
    await expectLedgerConsistent();
  });

  it('credits exactly once when the same event is processed concurrently by many workers', async () => {
    const ref = `btc:${orgId}:race`;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        inTransaction(db, (tx) =>
          postConfirmedDeposit(tx, {
            organizationId: orgId,
            assetId: 'btc',
            amount: 1_000n,
            depositRef: ref,
          }),
        ),
      ),
    );
    const fulfilled = results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<{ created: boolean }>).value);
    expect(fulfilled).toHaveLength(10);
    expect(fulfilled.filter((r) => r.created)).toHaveLength(1);
    expect(await available(orgId, 'btc')).toBe(1_000n);
  });

  it('rejects a replay of the same reference with a different amount', async () => {
    const ref = `eth:${orgId}:tamper`;
    await inTransaction(db, (tx) =>
      postConfirmedDeposit(tx, {
        organizationId: orgId,
        assetId: 'eth',
        amount: 10n,
        depositRef: ref,
      }),
    );
    await expect(
      inTransaction(db, (tx) =>
        postConfirmedDeposit(tx, {
          organizationId: orgId,
          assetId: 'eth',
          amount: 11n,
          depositRef: ref,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await available(orgId, 'eth')).toBe(10n);
  });

  it('handles 18-decimal amounts far beyond Number.MAX_SAFE_INTEGER exactly', async () => {
    const huge = 123_456_789_012_345_678_901_234_567n;
    await inTransaction(db, (tx) =>
      postConfirmedDeposit(tx, {
        organizationId: orgId,
        assetId: 'eth',
        amount: huge,
        depositRef: `eth:${orgId}:huge`,
      }),
    );
    expect(await available(orgId, 'eth')).toBe(huge);
    await expectLedgerConsistent();
  });
});

describe('withdrawals', () => {
  beforeEach(async () => {
    await inTransaction(db, (tx) =>
      postConfirmedDeposit(tx, {
        organizationId: orgId,
        assetId: 'xrp',
        amount: 1_000_000n,
        depositRef: `xrp:${orgId}:seed`,
      }),
    );
  });

  it('holds amount + fee and refuses to overdraw', async () => {
    await inTransaction(db, (tx) =>
      postWithdrawalHold(tx, {
        organizationId: orgId,
        assetId: 'xrp',
        withdrawalId: `${orgId}-w1`,
        amount: 600_000n,
        feeCharged: 1_000n,
      }),
    );
    expect(await available(orgId, 'xrp')).toBe(399_000n);

    await expect(
      inTransaction(db, (tx) =>
        postWithdrawalHold(tx, {
          organizationId: orgId,
          assetId: 'xrp',
          withdrawalId: `${orgId}-w2`,
          amount: 399_000n,
          feeCharged: 1n,
        }),
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(await available(orgId, 'xrp')).toBe(399_000n);
  });

  it('lets exactly as many concurrent withdrawals succeed as the balance covers', async () => {
    // Balance 1,000,000; 20 concurrent requests of 300,000 → exactly 3 can win.
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        inTransaction(db, (tx) =>
          postWithdrawalHold(tx, {
            organizationId: orgId,
            assetId: 'xrp',
            withdrawalId: `${orgId}-c${i}`,
            amount: 300_000n,
            feeCharged: 0n,
          }),
        ),
      ),
    );
    const won = attempts.filter((a) => a.status === 'fulfilled');
    const lost = attempts.filter((a): a is PromiseRejectedResult => a.status === 'rejected');
    expect(won).toHaveLength(3);
    for (const loss of lost) expect((loss.reason as AppError).code).toBe('INSUFFICIENT_BALANCE');
    expect(await available(orgId, 'xrp')).toBe(100_000n);
    await expectLedgerConsistent();
  });

  it('releases a cancelled withdrawal back to available', async () => {
    const withdrawalId = `${orgId}-cancel`;
    await inTransaction(db, (tx) =>
      postWithdrawalHold(tx, {
        organizationId: orgId,
        assetId: 'xrp',
        withdrawalId,
        amount: 500_000n,
        feeCharged: 100n,
      }),
    );
    await inTransaction(db, (tx) =>
      postWithdrawalRelease(tx, {
        organizationId: orgId,
        assetId: 'xrp',
        withdrawalId,
        total: 500_100n,
      }),
    );
    expect(await available(orgId, 'xrp')).toBe(1_000_000n);
    await expectLedgerConsistent();
  });

  it('settles a token withdrawal with the network fee booked in the fee asset', async () => {
    // Platform needs ETH in custody to pay gas: model an operator top-up.
    await inTransaction(db, (tx) =>
      postConfirmedDeposit(tx, {
        organizationId: orgId,
        assetId: 'eth',
        amount: 10n ** 18n,
        depositRef: `eth:${orgId}:gas`,
      }),
    );
    await inTransaction(db, (tx) =>
      postConfirmedDeposit(tx, {
        organizationId: orgId,
        assetId: 'usdt-erc20',
        amount: 50_000_000n,
        depositRef: `usdt:${orgId}:1`,
      }),
    );

    const custodyEthBefore = await platform('eth', 'custody');
    const feesBefore = await platform('eth', 'network_fees');
    const revenueBefore = await platform('usdt-erc20', 'platform_revenue');

    const withdrawalId = `${orgId}-usdt`;
    await inTransaction(db, (tx) =>
      postWithdrawalHold(tx, {
        organizationId: orgId,
        assetId: 'usdt-erc20',
        withdrawalId,
        amount: 20_000_000n,
        feeCharged: 1_000_000n,
      }),
    );
    await inTransaction(db, (tx) =>
      postWithdrawalSettled(tx, {
        organizationId: orgId,
        assetId: 'usdt-erc20',
        withdrawalId,
        amount: 20_000_000n,
        feeCharged: 1_000_000n,
        networkFee: { assetId: 'eth', amount: 2_100_000_000_000_000n },
      }),
    );

    expect(await available(orgId, 'usdt-erc20')).toBe(29_000_000n);
    expect(await platform('usdt-erc20', 'platform_revenue')).toBe(revenueBefore + 1_000_000n);
    expect(await platform('eth', 'network_fees')).toBe(feesBefore + 2_100_000_000_000_000n);
    expect(await platform('eth', 'custody')).toBe(custodyEthBefore - 2_100_000_000_000_000n);
    await expectLedgerConsistent();
  });
});

describe('tenant isolation', () => {
  it("refuses a journal that moves another organization's funds", async () => {
    const victim = await createOrganization(db, 'Victim');
    await inTransaction(db, (tx) =>
      postConfirmedDeposit(tx, {
        organizationId: victim,
        assetId: 'btc',
        amount: 5_000n,
        depositRef: `btc:${victim}:v`,
      }),
    );
    await expect(
      inTransaction(db, async (tx) => {
        const victimAccount = await ensureAccount(tx, {
          organizationId: victim,
          assetId: 'btc',
          type: 'org_available',
        });
        const attacker = await ensureAccount(tx, {
          organizationId: orgId,
          assetId: 'btc',
          type: 'org_available',
        });
        return postJournal(tx, {
          externalRef: `attack:${orgId}`,
          kind: 'adjustment',
          organizationId: orgId,
          lines: [
            { accountId: victimAccount.id, direction: 'debit', amount: 5_000n },
            { accountId: attacker.id, direction: 'credit', amount: 5_000n },
          ],
        });
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await available(victim, 'btc')).toBe(5_000n);
  });
});

describe('reversals', () => {
  it('reverses a journal once and keeps the original in history', async () => {
    const { journalId } = await inTransaction(db, (tx) =>
      postConfirmedDeposit(tx, {
        organizationId: orgId,
        assetId: 'ltc',
        amount: 7_000n,
        depositRef: `ltc:${orgId}:reorg`,
      }),
    );
    const reversal = await inTransaction(db, (tx) =>
      reverseJournal(tx, { journalId, externalRef: `reorg:${journalId}` }),
    );
    expect(reversal.created).toBe(true);
    expect(await available(orgId, 'ltc')).toBe(0n);

    // Idempotent with the same ref; rejected with a different one.
    expect(
      (
        await inTransaction(db, (tx) =>
          reverseJournal(tx, { journalId, externalRef: `reorg:${journalId}` }),
        )
      ).created,
    ).toBe(false);
    await expect(
      inTransaction(db, (tx) =>
        reverseJournal(tx, { journalId, externalRef: `other:${journalId}` }),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
    const original = await db
      .selectFrom('ledger_journals')
      .select('id')
      .where('id', '=', journalId)
      .executeTakeFirst();
    expect(original).toBeDefined();
    await expectLedgerConsistent();
  });

  it('refuses to reverse a deposit whose funds were already withdrawn', async () => {
    const { journalId } = await inTransaction(db, (tx) =>
      postConfirmedDeposit(tx, {
        organizationId: orgId,
        assetId: 'ltc',
        amount: 9_000n,
        depositRef: `ltc:${orgId}:spent`,
      }),
    );
    await inTransaction(db, (tx) =>
      postWithdrawalHold(tx, {
        organizationId: orgId,
        assetId: 'ltc',
        withdrawalId: `${orgId}-spent`,
        amount: 9_000n,
        feeCharged: 0n,
      }),
    );
    // Reversal would push org_available negative: it must fail, and a human
    // must resolve the shortfall (e.g. via suspense) explicitly.
    await expect(
      inTransaction(db, (tx) =>
        reverseJournal(tx, { journalId, externalRef: `reorg:${journalId}` }),
      ),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
  });
});

describe('database-level guarantees (bypassing the application)', () => {
  it('rejects an unbalanced journal at COMMIT even when written with raw SQL', async () => {
    await expect(
      db.transaction().execute(async (tx) => {
        const custody = await ensureAccount(tx, {
          organizationId: null,
          assetId: 'btc',
          type: 'custody',
        });
        const j = await tx
          .insertInto('ledger_journals')
          .values({
            external_ref: `raw:${orgId}`,
            kind: 'adjustment',
            organization_id: null,
            content_hash: 'f'.repeat(64),
            metadata: '{}',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await tx
          .insertInto('ledger_entries')
          .values([
            {
              journal_id: j.id,
              account_id: custody.id,
              asset_id: 'btc',
              direction: 'debit',
              amount: '100',
            },
            {
              journal_id: j.id,
              account_id: custody.id,
              asset_id: 'btc',
              direction: 'credit',
              amount: '99',
            },
          ])
          .execute();
      }),
    ).rejects.toThrow(/does not balance/);
  });

  it('rejects a journal with no entries at COMMIT', async () => {
    await expect(
      db
        .insertInto('ledger_journals')
        .values({
          external_ref: `empty:${orgId}`,
          kind: 'adjustment',
          organization_id: null,
          content_hash: 'e'.repeat(64),
          metadata: '{}',
        })
        .execute(),
    ).rejects.toThrow(/at least 2 required/);
  });

  it('blocks negative balances via the CHECK constraint', async () => {
    const account = await inTransaction(db, (tx) =>
      ensureAccount(tx, { organizationId: orgId, assetId: 'btc', type: 'org_available' }),
    );
    await expect(
      db
        .updateTable('ledger_accounts')
        .set({ balance: '-1' })
        .where('id', '=', account.id)
        .execute(),
    ).rejects.toThrow(/non_negative/);
  });

  it('forbids editing or deleting ledger history', async () => {
    await inTransaction(db, (tx) =>
      postConfirmedDeposit(tx, {
        organizationId: orgId,
        assetId: 'btc',
        amount: 1n,
        depositRef: `btc:${orgId}:imm`,
      }),
    );
    await expect(db.updateTable('ledger_entries').set({ amount: '2' }).execute()).rejects.toThrow(
      /append-only/,
    );
    await expect(db.deleteFrom('ledger_entries').execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('ledger_journals').execute()).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE ledger_entries`.execute(db)).rejects.toThrow(/append-only/);
  });

  it('forbids re-pointing an account to another organization', async () => {
    const other = await createOrganization(db);
    const account = await inTransaction(db, (tx) =>
      ensureAccount(tx, { organizationId: orgId, assetId: 'btc', type: 'org_available' }),
    );
    await expect(
      sql`UPDATE ledger_accounts SET organization_id = ${other} WHERE id = ${account.id}`.execute(
        db,
      ),
    ).rejects.toThrow(/only balance may change/);
  });

  it("forbids an entry whose asset differs from its account's asset", async () => {
    await expect(
      db.transaction().execute(async (tx) => {
        const btc = await ensureAccount(tx, {
          organizationId: null,
          assetId: 'btc',
          type: 'custody',
        });
        const j = await tx
          .insertInto('ledger_journals')
          .values({
            external_ref: `mix:${orgId}`,
            kind: 'adjustment',
            organization_id: null,
            content_hash: 'd'.repeat(64),
            metadata: '{}',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await tx
          .insertInto('ledger_entries')
          .values({
            journal_id: j.id,
            account_id: btc.id,
            asset_id: 'eth',
            direction: 'debit',
            amount: '1',
          })
          .execute();
      }),
    ).rejects.toThrow(/foreign key/);
  });
});
