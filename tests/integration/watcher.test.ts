/**
 * The watcher: cursors, scan loop, rechecks and reorgs, the mass-reversal
 * breaker, leases, reconciliation, and the worker cycle. Uses a fake chain so
 * failures can be injected deterministically.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IncomingTransfer } from '@actualpay/chains';
import { inTransaction, type Db } from '@actualpay/database';
import { ensureAccount, postWithdrawalHold } from '@actualpay/ledger';
import { createInvoice, getInvoice, type InvoiceView } from '@actualpay/payments';
import { confirmWallet, createWallet } from '@actualpay/wallets';
import {
  acquireLease,
  getCursor,
  listIssues,
  openIssue,
  reconcileOnce,
  recheckPayments,
  releaseLease,
  resolveIssue,
  runCycle,
  runLeased,
  scanChain,
} from '@actualpay/watcher';
import { createLogger } from '@actualpay/shared';
import { FakeAdapter } from './fake-adapter';
import { createOrganization, createTestDb, resetDatabase } from './helpers';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const logger = createLogger({ name: 'test', level: 'silent' });
const meta = { requestId: 'test' };

let db: Db;
let userId: string;
let seq = 200;
let adapter: FakeAdapter;

beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.destroy();
});
// Every test starts from an empty database: payments left by one test would
// look "missing" to the next test's fresh fake chain.
beforeEach(async () => {
  await resetDatabase(db);
  const user = await db
    .insertInto('users')
    .values({
      email: 'watcher@example.test',
      password_hash: '$argon2id$v=19$m=19456,t=2,p=1$dGVzdA$dGVzdA',
      display_name: 'Watcher Test',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  userId = user.id;
  adapter = new FakeAdapter();
});

async function orgWithWallet(): Promise<string> {
  seq += 1;
  const orgId = await createOrganization(db);
  const { wallet, firstAddress } = await createWallet(
    db,
    {
      organizationId: orgId,
      actor: { type: 'user', id: userId },
      chain: 'ethereum',
      network: 'testnet',
      enabledChains: ['ethereum'],
      label: 'ETH',
      accountXpub: HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive(`m/44'/60'/${seq}'`)
        .publicExtendedKey,
    },
    meta,
  );
  await confirmWallet(
    db,
    {
      organizationId: orgId,
      walletId: wallet.id,
      actor: { type: 'user', id: userId },
      address: firstAddress.address,
    },
    meta,
  );
  return orgId;
}

async function newInvoice(orgId: string, amount = 1_000n): Promise<InvoiceView> {
  return (
    await createInvoice(
      db,
      {
        organizationId: orgId,
        actor: { type: 'user', id: userId },
        assetId: 'eth',
        amount,
        network: 'testnet',
        enabledAssets: ['eth'],
      },
      meta,
    )
  ).invoice;
}

function transfer(
  invoice: InvoiceView,
  overrides: Partial<IncomingTransfer> = {},
): IncomingTransfer {
  const hash = `0x${randomBytes(32).toString('hex')}`;
  return {
    ref: `eth:${hash}:native`,
    assetId: 'eth',
    txHash: hash,
    toAddress: invoice.address,
    amount: 1_000n,
    blockHeight: 95n,
    blockHash: `0x${randomBytes(32).toString('hex')}`,
    confirmations: 6n,
    final: false,
    ...overrides,
  };
}

const scan = () => scanChain({ db, logger, adapter });
const recheck = (extra: { massReversalThreshold?: number } = {}) =>
  recheckPayments({ db, logger, adapters: new Map([['ethereum', adapter]]), ...extra });
const statusOf = async (orgId: string, invoice: InvoiceView) =>
  (await getInvoice(db, orgId, invoice.id)).status;
const balance = (orgId: string) =>
  inTransaction(
    db,
    async (tx) =>
      (await ensureAccount(tx, { organizationId: orgId, assetId: 'eth', type: 'org_available' }))
        .balance,
  );

describe('cursor initialisation', () => {
  it('starts only when there is a confirmed wallet, at the current tip, and unlocks invoices', async () => {
    await db
      .deleteFrom('chain_cursors')
      .execute()
      .catch(() => undefined);
    expect(await scan()).toEqual({ kind: 'skipped', reason: 'nothing_to_watch' });
    expect(await getCursor(db, 'ethereum', 'testnet')).toBeUndefined();

    const orgId = await orgWithWallet();
    await expect(newInvoice(orgId)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(await scan()).toEqual({ kind: 'initialised' });
    expect((await getCursor(db, 'ethereum', 'testnet'))?.cursor).toBe('100');
    await expect(newInvoice(orgId)).resolves.toBeDefined();
    // A second scan on an initialised chain just scans.
    expect((await scan()).kind).toBe('scanned');
  });
});

describe('scan loop', () => {
  it('turns a seen transfer into a pending payment, then a credited one once final', async () => {
    const orgId = await orgWithWallet();
    await scan();
    const invoice = await newInvoice(orgId);
    const t = transfer(invoice);
    adapter.add(t);
    adapter.tip = 120n;

    const first = await scan();
    expect(first).toMatchObject({ kind: 'scanned', rejected: 0 });
    expect(await statusOf(orgId, invoice)).toBe('processing');
    expect(await balance(orgId)).toBe(0n);
    expect((await getCursor(db, 'ethereum', 'testnet'))?.cursor).toBe('120');

    adapter.add({ ...t, final: true, confirmations: 30n });
    await scan();
    expect(await statusOf(orgId, invoice)).toBe('paid');
    expect(await balance(orgId)).toBe(1_000n);
    for (let i = 0; i < 3; i++) await scan(); // re-scans change nothing
    expect(await balance(orgId)).toBe(1_000n);
  });

  it('does not scan or finalise while the node is syncing', async () => {
    const orgId = await orgWithWallet();
    await scan();
    const invoice = await newInvoice(orgId);
    adapter.add(transfer(invoice, { final: true }));
    adapter.synced = false;
    expect(await scan()).toEqual({ kind: 'skipped', reason: 'unsynced' });
    expect(await statusOf(orgId, invoice)).toBe('open');
    const row = await getCursor(db, 'ethereum', 'testnet');
    expect(row?.synced).toBe(false);
    adapter.synced = true;
    await scan();
    expect(await statusOf(orgId, invoice)).toBe('paid');
  });

  it('keeps the cursor and records the error when the node fails, then recovers', async () => {
    const orgId = await orgWithWallet();
    await scan();
    await newInvoice(orgId);
    const before = (await getCursor(db, 'ethereum', 'testnet'))?.cursor;
    adapter.tip = 500n;
    adapter.failNext = 'scanIncoming';
    const failed = await scan();
    expect(failed.kind).toBe('failed');
    const row = await getCursor(db, 'ethereum', 'testnet');
    expect(row?.cursor).toBe(before);
    expect(row?.last_error).toMatch(/injected scanIncoming/);
    await scan();
    const healed = await getCursor(db, 'ethereum', 'testnet');
    expect(healed?.cursor).toBe('500');
    expect(healed?.last_error).toBeNull();
  });

  it('raises an issue for a contradictory transfer without blocking the rest', async () => {
    const orgId = await orgWithWallet();
    await scan();
    const invoice = await newInvoice(orgId);
    const good = transfer(invoice);
    adapter.add(good);
    await scan();
    // Same chain reference, different amount: impossible on a real chain.
    adapter.add({ ...good, amount: 999n });
    const other = transfer(invoice, { amount: 5n });
    adapter.add(other);
    adapter.tip = 130n;
    const outcome = await scan();
    expect(outcome.kind).toBe('scanned');
    expect(outcome.kind === 'scanned' && outcome.rejected).toBeGreaterThanOrEqual(1);
    const issues = await listIssues(db, { status: 'open' });
    expect(issues.some((i) => i.kind === 'observation_rejected' && i.subject_id === good.ref)).toBe(
      true,
    );
    expect((await getCursor(db, 'ethereum', 'testnet'))?.cursor).toBe('130');
    const payments = await db
      .selectFrom('payments')
      .select('ref')
      .where('invoice_id', '=', invoice.id)
      .execute();
    expect(payments.map((p) => p.ref)).toContain(other.ref);
  });
});

describe('rechecks and reorgs', () => {
  async function confirmedPayment(orgId: string, amount = 1_000n) {
    const invoice = await newInvoice(orgId, amount);
    const t = transfer(invoice, { amount, final: true });
    adapter.add(t);
    await scan();
    return { invoice, t };
  }

  it('reverses a payment the chain no longer shows, and credits again if it returns', async () => {
    const orgId = await orgWithWallet();
    await scan();
    const { invoice, t } = await confirmedPayment(orgId);
    expect(await balance(orgId)).toBe(1_000n);

    adapter.drop(t.ref);
    const summary = await recheck();
    expect(summary.reversed).toBe(1);
    expect(await balance(orgId)).toBe(0n);
    expect(await statusOf(orgId, invoice)).toBe('open');

    adapter.add(t);
    await scan();
    expect(await statusOf(orgId, invoice)).toBe('paid');
    expect(await balance(orgId)).toBe(1_000n);
  });

  it('does not reverse anything while the node is unsynced or unreachable', async () => {
    const orgId = await orgWithWallet();
    await scan();
    const { t } = await confirmedPayment(orgId);
    adapter.drop(t.ref);
    adapter.synced = false;
    expect((await recheck()).reversed).toBe(0);
    adapter.synced = true;
    adapter.failNext = 'status';
    expect((await recheck()).reversed).toBe(0);
    expect(await balance(orgId)).toBe(1_000n);
  });

  it('refuses a mass reversal and asks a human instead', async () => {
    const orgId = await orgWithWallet();
    await scan();
    const originals: IncomingTransfer[] = [];
    for (let i = 0; i < 6; i++) originals.push((await confirmedPayment(orgId, 100n)).t);
    expect(await balance(orgId)).toBe(600n);
    for (const t of originals) adapter.drop(t.ref);

    const summary = await recheck({ massReversalThreshold: 5 });
    expect(summary).toMatchObject({ reversed: 0, suspended: 6 });
    expect(await balance(orgId)).toBe(600n);
    const open = await listIssues(db, { status: 'open' });
    expect(
      open.some((i) => i.kind === 'mass_reversal_suspected' && i.subject_id === 'ethereum'),
    ).toBe(true);

    // The node recovers and shows them again: nothing was lost, and the issue clears itself.
    for (const t of originals) adapter.add(t);
    await recheck({ massReversalThreshold: 5 });
    const after = await listIssues(db, { status: 'open' });
    expect(after.some((i) => i.kind === 'mass_reversal_suspected')).toBe(false);
    expect(await balance(orgId)).toBe(600n);
  });

  it('flags a reversal the books cannot absorb and leaves the payment confirmed', async () => {
    const orgId = await orgWithWallet();
    await scan();
    const { t } = await confirmedPayment(orgId);
    await inTransaction(db, (tx) =>
      postWithdrawalHold(tx, {
        organizationId: orgId,
        assetId: 'eth',
        withdrawalId: randomBytes(8).toString('hex'),
        amount: 1_000n,
        feeCharged: 0n,
      }),
    );
    adapter.drop(t.ref);
    expect((await recheck()).blocked).toBe(1);
    const issue = (await listIssues(db, { status: 'open' })).find(
      (i) => i.kind === 'reversal_blocked',
    );
    expect(issue?.subject_id).toBe(t.ref);
    expect(issue?.severity).toBe('critical');
    const row = await db
      .selectFrom('payments')
      .select('status')
      .where('ref', '=', t.ref)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('confirmed');
  });
});

describe('leases', () => {
  it('lets one holder at a time, and frees an expired or released lease', async () => {
    const name = `test:lease:${randomBytes(4).toString('hex')}`;
    const results = await Promise.all([
      acquireLease(db, name, 'a', 60),
      acquireLease(db, name, 'b', 60),
      acquireLease(db, name, 'c', 60),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await acquireLease(db, name, 'd', 60)).toBe(false);
    await sql`UPDATE job_leases SET locked_until = now() - interval '1 second' WHERE name = ${name}`.execute(
      db,
    );
    expect(await acquireLease(db, name, 'e', 60)).toBe(true);
    await releaseLease(db, name, 'e');
    expect(await acquireLease(db, name, 'f', 60)).toBe(true);
  });

  it('skips a task another worker is running and records task errors', async () => {
    const name = `test:run:${randomBytes(4).toString('hex')}`;
    let inside = false;
    const first = runLeased(db, { name, owner: 'a', ttlSeconds: 60 }, async () => {
      inside = true;
      const other = await runLeased(db, { name, owner: 'b', ttlSeconds: 60 }, () =>
        Promise.resolve('x'),
      );
      expect(other).toEqual({ ran: false });
      return 'done';
    });
    expect(await first).toEqual({ ran: true, value: 'done' });
    expect(inside).toBe(true);
    await expect(
      runLeased(db, { name, owner: 'a', ttlSeconds: 60 }, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    const row = await db
      .selectFrom('job_leases')
      .select('last_error')
      .where('name', '=', name)
      .executeTakeFirstOrThrow();
    expect(row.last_error).toBe('boom');
    expect(await acquireLease(db, name, 'z', 60)).toBe(true); // released after the failure
  });
});

describe('issues and reconciliation', () => {
  it('collapses repeats into one open issue and requires a note to resolve', async () => {
    const subject = `x-${randomBytes(4).toString('hex')}`;
    for (let i = 0; i < 3; i++)
      await openIssue(db, {
        kind: 'test_issue',
        severity: 'warning',
        subjectType: 'thing',
        subjectId: subject,
        summary: 's',
      });
    const rows = await db
      .selectFrom('reconciliation_issues')
      .selectAll()
      .where('subject_id', '=', subject)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurrences).toBe(3);
    await expect(
      resolveIssue(db, { issueId: rows[0]!.id, userId, note: ' ' }, meta),
    ).rejects.toThrow(/note/);
    const resolved = await resolveIssue(
      db,
      { issueId: rows[0]!.id, userId, note: 'checked by hand' },
      meta,
    );
    expect(resolved.status).toBe('resolved');
    await expect(
      resolveIssue(db, { issueId: rows[0]!.id, userId, note: 'again please' }, meta),
    ).rejects.toThrow(/not found/i);
    // The same problem later opens a fresh issue.
    await openIssue(db, {
      kind: 'test_issue',
      severity: 'warning',
      subjectType: 'thing',
      subjectId: subject,
      summary: 's',
    });
    const again = await db
      .selectFrom('reconciliation_issues')
      .select('status')
      .where('subject_id', '=', subject)
      .execute();
    expect(again.map((r) => r.status).sort()).toEqual(['open', 'resolved']);
  });

  it('detects drifted invoice totals and a stale watcher, and clears them when fixed', async () => {
    const orgId = await orgWithWallet();
    await scan();
    const invoice = await newInvoice(orgId);
    adapter.add(transfer(invoice, { final: true }));
    await scan();

    await db
      .updateTable('invoices')
      .set({ amount_confirmed: '1' })
      .where('id', '=', invoice.id)
      .execute();
    await sql`UPDATE chain_cursors SET scanned_at = now() - interval '2 hours' WHERE chain = 'ethereum'`.execute(
      db,
    );
    const first = await reconcileOnce({ db, logger });
    expect(first.problems).toBeGreaterThanOrEqual(2);
    const open = await listIssues(db, { status: 'open' });
    expect(
      open.some((i) => i.kind === 'invoice_totals_mismatch' && i.subject_id === invoice.id),
    ).toBe(true);
    expect(open.some((i) => i.kind === 'watcher_stale' && i.subject_id === 'ethereum')).toBe(true);

    await db
      .updateTable('invoices')
      .set({ amount_confirmed: '1000' })
      .where('id', '=', invoice.id)
      .execute();
    await scan(); // refreshes scanned_at
    await reconcileOnce({ db, logger });
    const after = await listIssues(db, { status: 'open' });
    expect(
      after.some((i) => i.kind === 'invoice_totals_mismatch' && i.subject_id === invoice.id),
    ).toBe(false);
    expect(after.some((i) => i.kind === 'watcher_stale')).toBe(false);
  });

  it('reports a clean ledger as healthy', async () => {
    await reconcileOnce({ db, logger });
    const open = await listIssues(db, { status: 'open' });
    expect(open.some((i) => i.kind === 'ledger_integrity')).toBe(false);
  });
});

describe('worker cycle', () => {
  it('scans, rechecks, expires and reconciles in one pass, and respects held leases', async () => {
    const orgId = await orgWithWallet();
    await scan();
    const past = new Date(Date.now() - 3 * 3_600_000);
    const stale = (
      await createInvoice(
        db,
        {
          organizationId: orgId,
          actor: { type: 'user', id: userId },
          assetId: 'eth',
          amount: 10n,
          network: 'testnet',
          enabledAssets: ['eth'],
          now: past,
          expiresInMinutes: 5,
        },
        meta,
      )
    ).invoice;
    const live = await newInvoice(orgId);
    adapter.add(transfer(live, { final: true }));

    const deps = {
      db,
      logger,
      adapters: new Map([['ethereum' as const, adapter]]),
      ownerId: 'test',
    };
    const result = await runCycle(deps);
    expect(result.scans['ethereum:testnet']).toMatchObject({ kind: 'scanned' });
    expect(await statusOf(orgId, live)).toBe('paid');
    expect(await statusOf(orgId, stale)).toBe('expired');
    expect(result.reconciled).toMatchObject({ problems: expect.any(Number) as number });

    await acquireLease(db, 'scan:ethereum:testnet', 'someone-else', 60);
    const blocked = await runCycle({ ...deps, ownerId: 'me' });
    expect(blocked.scans['ethereum:testnet']).toEqual({ kind: 'lease_held' });
  });
});
