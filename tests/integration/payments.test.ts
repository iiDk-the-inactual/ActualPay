/**
 * Payments service: invoice lifecycle, idempotent observation handling, ledger
 * postings and reversals, expiry and database guards.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction, type Db } from '@actualpay/database';
import { ensureAccount, postWithdrawalHold, verifyLedgerIntegrity } from '@actualpay/ledger';
import {
  cancelInvoice,
  createInvoice,
  expireInvoices,
  getInvoice,
  recordObservation,
  reversePayment,
  type CreateInvoiceParams,
  type InvoiceView,
  type PaymentObservation,
} from '@actualpay/payments';
import { confirmWallet, createWallet } from '@actualpay/wallets';
import { createOrganization, createTestDb, resetDatabase } from './helpers';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ENABLED = ['eth', 'usdt-erc20', 'xrp'] as const;
const XRPL_ADDRESS = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const meta = { requestId: 'test' };

let db: Db;
let userId: string;
let accountSeq = 0;

beforeAll(async () => {
  db = createTestDb();
  await resetDatabase(db);
  const user = await db
    .insertInto('users')
    .values({
      email: 'payments@example.test',
      password_hash: '$argon2id$v=19$m=19456,t=2,p=1$dGVzdA$dGVzdA',
      display_name: 'Payments Test',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  userId = user.id;
});
afterAll(async () => {
  await db.destroy();
});

function nextEthKey(): string {
  accountSeq += 1;
  return HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive(`m/44'/60'/${accountSeq}'`)
    .publicExtendedKey;
}

async function orgWithEthWallet(): Promise<{ orgId: string; walletId: string }> {
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
      accountXpub: nextEthKey(),
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
  return { orgId, walletId: wallet.id };
}

function invoiceParams(
  orgId: string,
  overrides: Partial<CreateInvoiceParams> = {},
): CreateInvoiceParams {
  return {
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    assetId: 'eth',
    amount: 1_000n,
    network: 'testnet',
    enabledAssets: ENABLED,
    ...overrides,
  };
}

async function newInvoice(orgId: string, overrides: Partial<CreateInvoiceParams> = {}) {
  return (await createInvoice(db, invoiceParams(orgId, overrides), meta)).invoice;
}

let txSeq = 0;
function observation(
  invoice: InvoiceView,
  overrides: Partial<PaymentObservation> = {},
): PaymentObservation {
  txSeq += 1;
  const hash = `0x${randomBytes(32).toString('hex')}`;
  return {
    chain: 'ethereum',
    network: 'testnet',
    ref: `eth:${hash}:native`,
    assetId: 'eth',
    txHash: hash,
    toAddress: invoice.address,
    amount: 1_000n,
    blockHeight: BigInt(100 + txSeq),
    blockHash: `0x${randomBytes(32).toString('hex')}`,
    confirmations: 1n,
    final: false,
    ...overrides,
  };
}

const balanceOf = (orgId: string, assetId = 'eth') =>
  inTransaction(
    db,
    async (tx) =>
      (await ensureAccount(tx, { organizationId: orgId, assetId, type: 'org_available' })).balance,
  );

const statusOf = async (orgId: string, invoice: InvoiceView) =>
  (await getInvoice(db, orgId, invoice.id)).status;

describe('creating invoices', () => {
  it('allocates a fresh confirmed-wallet address per invoice', async () => {
    const { orgId } = await orgWithEthWallet();
    const a = await newInvoice(orgId);
    const b = await newInvoice(orgId);
    expect(a.status).toBe('open');
    expect(a.address).not.toBe(b.address);
    expect(a.public_id).toHaveLength(32);
    expect(BigInt(a.amount_due)).toBe(1_000n);
  });

  it('needs a confirmed wallet, an enabled asset and a sane expiry', async () => {
    const orgId = await createOrganization(db);
    await expect(createInvoice(db, invoiceParams(orgId), meta)).rejects.toThrow(
      /No confirmed ethereum wallet/,
    );
    const funded = await orgWithEthWallet();
    await expect(
      createInvoice(db, invoiceParams(funded.orgId, { enabledAssets: ['xrp'] }), meta),
    ).rejects.toThrow(/not enabled/);
    await expect(
      createInvoice(db, invoiceParams(funded.orgId, { expiresInMinutes: 1 }), meta),
    ).rejects.toThrow(/expiresInMinutes/);
    await expect(
      createInvoice(db, invoiceParams(funded.orgId, { amount: 0n }), meta),
    ).rejects.toThrow(/greater than zero/);
  });

  it('requires walletId when two confirmed wallets could serve the chain', async () => {
    const first = await orgWithEthWallet();
    const second = await createWallet(
      db,
      {
        organizationId: first.orgId,
        actor: { type: 'user', id: userId },
        chain: 'ethereum',
        network: 'testnet',
        enabledChains: ['ethereum'],
        label: 'second',
        accountXpub: nextEthKey(),
      },
      meta,
    );
    await confirmWallet(
      db,
      {
        organizationId: first.orgId,
        walletId: second.wallet.id,
        actor: { type: 'user', id: userId },
        address: second.firstAddress.address,
      },
      meta,
    );
    await expect(createInvoice(db, invoiceParams(first.orgId), meta)).rejects.toThrow(
      /specify walletId/,
    );
    const ok = await createInvoice(
      db,
      invoiceParams(first.orgId, { walletId: second.wallet.id }),
      meta,
    );
    expect(ok.invoice.wallet_id).toBe(second.wallet.id);
  });

  it('is idempotent on externalId and rejects changed terms', async () => {
    const { orgId } = await orgWithEthWallet();
    const first = await createInvoice(db, invoiceParams(orgId, { externalId: 'order-1' }), meta);
    const again = await createInvoice(db, invoiceParams(orgId, { externalId: 'order-1' }), meta);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.invoice.id).toBe(first.invoice.id);
    await expect(
      createInvoice(db, invoiceParams(orgId, { externalId: 'order-1', amount: 5n }), meta),
    ).rejects.toThrow(/different terms/);
    // Parallel creation with one order id yields exactly one invoice and no burnt address.
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        createInvoice(db, invoiceParams(orgId, { externalId: 'order-2' }), meta),
      ),
    );
    expect(new Set(results.map((r) => r.invoice.id)).size).toBe(1);
  });
});

describe('payment lifecycle and ledger', () => {
  it('goes processing → paid and credits the merchant exactly once', async () => {
    const { orgId } = await orgWithEthWallet();
    const invoice = await newInvoice(orgId);
    const seen = observation(invoice);

    const first = await recordObservation(db, seen);
    expect(first.kind).toBe('recorded');
    expect(await statusOf(orgId, invoice)).toBe('processing');
    expect(await balanceOf(orgId)).toBe(0n); // nothing credited before finality

    await recordObservation(db, { ...seen, confirmations: 5n, final: true });
    const paid = await getInvoice(db, orgId, invoice.id);
    expect(paid.status).toBe('paid');
    expect(paid.paid_at).not.toBeNull();
    expect(paid.paid_late).toBe(false);
    expect(await balanceOf(orgId)).toBe(1_000n);

    // Replays and re-observations change nothing.
    for (let i = 0; i < 3; i++)
      await recordObservation(db, { ...seen, confirmations: 9n, final: true });
    expect(await balanceOf(orgId)).toBe(1_000n);
    const rows = await db
      .selectFrom('payments')
      .select('id')
      .where('invoice_id', '=', invoice.id)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('credits once under concurrent observers of the same transfer', async () => {
    const { orgId } = await orgWithEthWallet();
    const invoice = await newInvoice(orgId);
    const seen = observation(invoice, { final: true, confirmations: 12n });
    await Promise.all(Array.from({ length: 12 }, () => recordObservation(db, seen)));
    expect(await balanceOf(orgId)).toBe(1_000n);
    const journals = await db
      .selectFrom('ledger_journals')
      .select('id')
      .where('external_ref', '=', `deposit:${seen.ref}`)
      .execute();
    expect(journals).toHaveLength(1);
    expect(await statusOf(orgId, invoice)).toBe('paid');
  });

  it('handles partial payments and overpayment', async () => {
    const { orgId } = await orgWithEthWallet();
    const invoice = await newInvoice(orgId, { amount: 1_000n });
    await recordObservation(db, observation(invoice, { amount: 400n, final: true }));
    expect(await statusOf(orgId, invoice)).toBe('partially_paid');
    await recordObservation(db, observation(invoice, { amount: 700n, final: true }));
    const paid = await getInvoice(db, orgId, invoice.id);
    expect(paid.status).toBe('paid');
    expect(BigInt(paid.amount_confirmed)).toBe(1_100n);
    expect(await balanceOf(orgId)).toBe(1_100n); // the excess is the merchant's too
  });

  it('credits money in another asset without counting it toward the invoice', async () => {
    const { orgId } = await orgWithEthWallet();
    const invoice = await newInvoice(orgId, { amount: 1_000n });
    const usdt = observation(invoice, {
      ref: `eth:0x${randomBytes(32).toString('hex')}:7`,
      assetId: 'usdt-erc20',
      amount: 5_000_000n,
      final: true,
    });
    await recordObservation(db, usdt);
    expect(await statusOf(orgId, invoice)).toBe('open');
    expect(await balanceOf(orgId, 'usdt-erc20')).toBe(5_000_000n);
    expect(await balanceOf(orgId, 'eth')).toBe(0n);
  });

  it('ignores transfers to unknown addresses and rejects a changed transfer', async () => {
    const { orgId } = await orgWithEthWallet();
    const invoice = await newInvoice(orgId);
    const stray = await recordObservation(
      db,
      observation(invoice, { toAddress: '0x' + '12'.repeat(20) }),
    );
    expect(stray).toEqual({ kind: 'ignored', reason: 'unknown_address' });
    const junk = await recordObservation(db, observation(invoice, { toAddress: 'not an address' }));
    expect(junk).toEqual({ kind: 'ignored', reason: 'invalid_address' });

    const seen = observation(invoice);
    await recordObservation(db, seen);
    await expect(recordObservation(db, { ...seen, amount: 999n })).rejects.toThrow(
      /does not match/,
    );
  });

  it('matches EVM addresses regardless of letter case', async () => {
    const { orgId } = await orgWithEthWallet();
    const invoice = await newInvoice(orgId);
    const outcome = await recordObservation(
      db,
      observation(invoice, { toAddress: invoice.address.toLowerCase(), final: true }),
    );
    expect(outcome.kind).toBe('recorded');
  });

  it('reverses a reorged payment and credits again if it is mined again', async () => {
    const { orgId } = await orgWithEthWallet();
    const invoice = await newInvoice(orgId);
    const seen = observation(invoice, { final: true });
    await recordObservation(db, seen);
    expect(await balanceOf(orgId)).toBe(1_000n);

    const reversed = await reversePayment(db, seen.ref);
    expect(reversed?.status).toBe('reversed');
    expect(await balanceOf(orgId)).toBe(0n);
    expect(await statusOf(orgId, invoice)).toBe('open');
    expect((await reversePayment(db, seen.ref))?.status).toBe('reversed'); // idempotent

    await recordObservation(db, { ...seen, final: false, confirmations: 1n });
    expect(await statusOf(orgId, invoice)).toBe('processing');
    await recordObservation(db, { ...seen, final: true, confirmations: 20n });
    expect(await statusOf(orgId, invoice)).toBe('paid');
    expect(await balanceOf(orgId)).toBe(1_000n);
    const payment = await db
      .selectFrom('payments')
      .selectAll()
      .where('ref', '=', seen.ref)
      .executeTakeFirstOrThrow();
    expect(payment.epoch).toBe(2);
    expect((await verifyLedgerIntegrity(db)).ok).toBe(true);
  });

  it('withdraws a pending payment without touching the ledger', async () => {
    const { orgId } = await orgWithEthWallet();
    const invoice = await newInvoice(orgId);
    const seen = observation(invoice);
    await recordObservation(db, seen);
    await reversePayment(db, seen.ref);
    expect(await balanceOf(orgId)).toBe(0n);
    expect(await statusOf(orgId, invoice)).toBe('open');
  });

  it('refuses to reverse when the merchant already spent the money, and changes nothing', async () => {
    const { orgId } = await orgWithEthWallet();
    const invoice = await newInvoice(orgId);
    const seen = observation(invoice, { final: true });
    await recordObservation(db, seen);
    await inTransaction(db, (tx) =>
      postWithdrawalHold(tx, {
        organizationId: orgId,
        assetId: 'eth',
        withdrawalId: randomBytes(8).toString('hex'),
        amount: 1_000n,
        feeCharged: 0n,
      }),
    );
    await expect(reversePayment(db, seen.ref)).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
    const payment = await db
      .selectFrom('payments')
      .select('status')
      .where('ref', '=', seen.ref)
      .executeTakeFirstOrThrow();
    expect(payment.status).toBe('confirmed');
    expect(await statusOf(orgId, invoice)).toBe('paid');
  });
});

describe('XRPL destination tags', () => {
  it('attributes payments by tag and ignores untagged or wrongly tagged ones', async () => {
    const orgId = await createOrganization(db);
    const { wallet, firstAddress } = await createWallet(
      db,
      {
        organizationId: orgId,
        actor: { type: 'user', id: userId },
        chain: 'xrpl',
        network: 'testnet',
        enabledChains: ['xrpl'],
        label: 'XRP',
        xrplAddress: XRPL_ADDRESS,
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
    const first = await newInvoice(orgId, { assetId: 'xrp', amount: 5_000_000n });
    const second = await newInvoice(orgId, { assetId: 'xrp', amount: 5_000_000n });
    expect([first.destination_tag, second.destination_tag]).toEqual(['1', '2']);

    const base = {
      chain: 'xrpl',
      network: 'testnet',
      assetId: 'xrp',
      toAddress: XRPL_ADDRESS,
      amount: 5_000_000n,
      blockHeight: 10n,
      blockHash: null,
      confirmations: 1n,
      final: true,
    } as const;
    const hash = (n: string) => n.repeat(64).slice(0, 64).toUpperCase();
    const untagged = await recordObservation(db, {
      ...base,
      ref: `xrp:${hash('a')}`,
      txHash: hash('a'),
    });
    expect(untagged).toEqual({ kind: 'ignored', reason: 'unknown_address' });
    const wrongTag = await recordObservation(db, {
      ...base,
      ref: `xrp:${hash('b')}`,
      txHash: hash('b'),
      destinationTag: 99,
    });
    expect(wrongTag).toEqual({ kind: 'ignored', reason: 'unknown_address' });

    await recordObservation(db, {
      ...base,
      ref: `xrp:${hash('c')}`,
      txHash: hash('c'),
      destinationTag: 2,
    });
    expect(await statusOf(orgId, second)).toBe('paid');
    expect(await statusOf(orgId, first)).toBe('open');
  });
});

describe('expiry and cancellation', () => {
  it('expires unpaid invoices, keeps in-flight ones, and accepts a late full payment', async () => {
    const { orgId } = await orgWithEthWallet();
    const past = new Date(Date.now() - 3 * 3_600_000);
    const unpaid = await newInvoice(orgId, { now: past, expiresInMinutes: 5 });
    const inFlight = await newInvoice(orgId, { now: past, expiresInMinutes: 5 });
    await recordObservation(db, observation(inFlight), new Date(past.getTime() + 60_000));

    expect(await expireInvoices(db, { now: new Date() })).toBeGreaterThanOrEqual(1);
    expect(await statusOf(orgId, unpaid)).toBe('expired');
    expect(await statusOf(orgId, inFlight)).toBe('processing');

    const late = observation(unpaid, { final: true });
    await recordObservation(db, late);
    const paid = await getInvoice(db, orgId, unpaid.id);
    expect(paid.status).toBe('paid');
    expect(paid.paid_late).toBe(true);
    expect(await balanceOf(orgId)).toBeGreaterThanOrEqual(1_000n);
  });

  it('cancels only invoices that received nothing', async () => {
    const { orgId } = await orgWithEthWallet();
    const empty = await newInvoice(orgId);
    const actor = { type: 'user', id: userId } as const;
    const cancelled = await cancelInvoice(
      db,
      { organizationId: orgId, invoiceId: empty.id, actor },
      meta,
    );
    expect(cancelled.status).toBe('cancelled');
    expect(
      (await cancelInvoice(db, { organizationId: orgId, invoiceId: empty.id, actor }, meta)).status,
    ).toBe('cancelled'); // idempotent

    const busy = await newInvoice(orgId);
    await recordObservation(db, observation(busy));
    await expect(
      cancelInvoice(db, { organizationId: orgId, invoiceId: busy.id, actor }, meta),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    // Money that still arrives for a cancelled invoice is credited and recognised.
    await recordObservation(db, observation(empty, { final: true }));
    expect(await statusOf(orgId, empty)).toBe('paid');
  });

  it("cannot cancel another organization's invoice", async () => {
    const a = await orgWithEthWallet();
    const b = await orgWithEthWallet();
    const invoice = await newInvoice(a.orgId);
    await expect(
      cancelInvoice(
        db,
        { organizationId: b.orgId, invoiceId: invoice.id, actor: { type: 'user', id: userId } },
        meta,
      ),
    ).rejects.toThrow(/not found/i);
  });
});

describe('events, books and database guards', () => {
  it('writes ordered domain events in the same transaction as the change', async () => {
    const { orgId } = await orgWithEthWallet();
    const invoice = await newInvoice(orgId);
    const seen = observation(invoice);
    await recordObservation(db, seen);
    await recordObservation(db, { ...seen, final: true });
    const events = await db
      .selectFrom('domain_events')
      .select('type')
      .where('organization_id', '=', orgId)
      .orderBy('id')
      .execute();
    expect(events.map((e) => e.type)).toEqual([
      'invoice.created',
      'payment.detected',
      'invoice.processing',
      'payment.confirmed',
      'invoice.paid',
    ]);
  });

  it('keeps the books balanced after all of the above', async () => {
    const report = await verifyLedgerIntegrity(db);
    expect(report.ok).toBe(true);
  });

  it('guards payments, invoices and events at the database level', async () => {
    const { orgId } = await orgWithEthWallet();
    const invoice = await newInvoice(orgId);
    const seen = observation(invoice, { final: true });
    await recordObservation(db, seen);

    const upd = (
      table: 'payments' | 'invoices',
      set: Record<string, unknown>,
      where: [string, string],
    ) =>
      db
        .updateTable(table)
        .set(set as never)
        .where(where[0] as never, '=', where[1] as never)
        .execute();
    await expect(upd('payments', { amount: '1' }, ['ref', seen.ref])).rejects.toThrow(/immutable/);
    await expect(upd('payments', { ref: 'eth:other:native' }, ['ref', seen.ref])).rejects.toThrow(
      /immutable/,
    );
    await expect(upd('payments', { status: 'pending' }, ['ref', seen.ref])).rejects.toThrow(
      /cannot go from/,
    );
    await expect(upd('payments', { epoch: 0 }, ['ref', seen.ref])).rejects.toThrow(/epoch/);
    await expect(db.deleteFrom('payments').where('ref', '=', seen.ref).execute()).rejects.toThrow(
      /append-only/,
    );
    await expect(upd('invoices', { amount_due: '1' }, ['id', invoice.id])).rejects.toThrow(
      /immutable/,
    );
    await expect(
      upd('invoices', { deposit_address_id: invoice.deposit_address_id }, ['id', invoice.id]),
    ).resolves.toBeDefined();
    await expect(db.deleteFrom('invoices').where('id', '=', invoice.id).execute()).rejects.toThrow(
      /append-only/,
    );
    await expect(db.deleteFrom('domain_events').execute()).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE domain_events`.execute(db)).rejects.toThrow(/append-only/);
  });

  it('gives one address to one invoice only', async () => {
    const { orgId, walletId } = await orgWithEthWallet();
    const invoice = await newInvoice(orgId);
    await expect(
      db
        .insertInto('invoices')
        .values({
          public_id: 'x'.repeat(32),
          organization_id: orgId,
          wallet_id: walletId,
          deposit_address_id: invoice.deposit_address_id,
          asset_id: 'eth',
          amount_due: '5',
          expires_at: new Date(Date.now() + 60_000),
          created_by_type: 'user',
          created_by_id: userId,
        })
        .execute(),
    ).rejects.toThrow(/duplicate key/);
  });
});
