/**
 * End to end against a real EVM node (Anvil): wallet → invoice → payment on
 * chain → worker cycle → credited, plus a withdrawn (reorged) pending payment.
 *
 * Requires EVM_TEST_RPC_URL pointing at a local anvil (chain id 31337).
 * Skipped otherwise. Never point this at a public network.
 */
import { randomBytes } from 'node:crypto';
import { HDKey } from '@scure/bip32';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvmAdapter, jsonRpc } from '@actualpay/chains';
import { inTransaction, type Db } from '@actualpay/database';
import { ensureAccount } from '@actualpay/ledger';
import { createInvoice, getInvoice, type InvoiceView } from '@actualpay/payments';
import { createLogger } from '@actualpay/shared';
import { confirmWallet, createWallet } from '@actualpay/wallets';
import { getCursor, runCycle } from '@actualpay/watcher';
import { createOrganization, createTestDb, resetDatabase } from './helpers';

const url = process.env['EVM_TEST_RPC_URL'];
const rpc = (method: string, params: unknown[] = []) => jsonRpc(url!, method, params);
const hex = (n: bigint) => `0x${n.toString(16)}`;
const logger = createLogger({ name: 'test', level: 'silent' });
const meta = { requestId: 'test' };

describe.skipIf(!url)('worker against anvil', () => {
  let db: Db;
  let orgId: string;
  let sender: string;
  let adapter: EvmAdapter;
  const deps = () => ({
    db,
    logger,
    adapters: new Map([['ethereum' as const, adapter]]),
    ownerId: 't',
  });

  const mine = async (n = 1) => {
    for (let i = 0; i < n; i++) await rpc('evm_mine');
  };
  const send = async (to: string, wei: bigint) => {
    const hash = (await rpc('eth_sendTransaction', [
      { from: sender, to, value: hex(wei) },
    ])) as string;
    await mine();
    return hash.toLowerCase();
  };
  const balance = () =>
    inTransaction(
      db,
      async (tx) =>
        (await ensureAccount(tx, { organizationId: orgId, assetId: 'eth', type: 'org_available' }))
          .balance,
    );
  const invoice = async (wei: bigint): Promise<InvoiceView> =>
    (
      await createInvoice(
        db,
        {
          organizationId: orgId,
          actor: { type: 'user', id: userId },
          assetId: 'eth',
          amount: wei,
          network: 'testnet',
          enabledAssets: ['eth'],
        },
        meta,
      )
    ).invoice;
  let userId: string;

  beforeAll(async () => {
    const id = BigInt((await rpc('eth_chainId')) as string);
    if (id !== 31337n) throw new Error('EVM_TEST_RPC_URL must be a local anvil chain (31337)');
    await rpc('evm_setAutomine', [false]);
    sender = ((await rpc('eth_accounts')) as string[])[0]!;

    db = createTestDb();
    await resetDatabase(db);
    userId = (
      await db
        .insertInto('users')
        .values({
          email: 'e2e-evm@example.test',
          password_hash: '$argon2id$v=19$m=19456,t=2,p=1$dGVzdA$dGVzdA',
          display_name: 'E2E',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    orgId = await createOrganization(db);
    const { wallet, firstAddress } = await createWallet(
      db,
      {
        organizationId: orgId,
        actor: { type: 'user', id: userId },
        chain: 'ethereum',
        network: 'testnet',
        enabledChains: ['ethereum'],
        label: 'e2e',
        accountXpub: HDKey.fromMasterSeed(randomBytes(32)).derive("m/44'/60'/0'").publicExtendedKey,
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
    adapter = new EvmAdapter({
      network: 'testnet',
      url: url!,
      chainId: 31337n,
      watchedAddresses: async () => {
        const rows = await db
          .selectFrom('deposit_addresses')
          .select('address')
          .where('chain', '=', 'ethereum')
          .execute();
        return new Set(rows.map((r) => r.address.toLowerCase()));
      },
      reorgOverlap: 4,
    });
  });
  afterAll(async () => {
    await db.destroy();
  });

  it('refuses invoices until the worker has started, then credits an exact payment once final', async () => {
    await expect(invoice(1n)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    const first = await runCycle(deps());
    expect(first.scans['ethereum:testnet']).toEqual({ kind: 'initialised' });
    expect((await getCursor(db, 'ethereum', 'testnet'))?.cursor).toMatch(/^[0-9]+$/);

    const wei = 1_234_567_890_123_456_789n;
    const inv = await invoice(wei);
    const hash = await send(inv.address, wei);

    await runCycle(deps());
    const seen = await getInvoice(db, orgId, inv.id);
    expect(seen.status).toBe('processing');
    expect(await balance()).toBe(0n);

    await mine(80); // enough for the node to finalize the block
    await runCycle(deps());
    const paid = await getInvoice(db, orgId, inv.id);
    expect(paid.status).toBe('paid');
    expect(BigInt(paid.amount_confirmed)).toBe(wei); // exact, no rounding
    expect(await balance()).toBe(wei);
    const payment = await db
      .selectFrom('payments')
      .select(['ref', 'tx_hash'])
      .where('invoice_id', '=', inv.id)
      .executeTakeFirstOrThrow();
    expect(payment.ref).toBe(`eth:${hash}:native`);

    // Further cycles are harmless.
    await runCycle(deps());
    await runCycle(deps());
    expect(await balance()).toBe(wei);
  });

  it('withdraws a pending payment when the chain reorganises it away', async () => {
    const wei = 777_000_000_000_000n;
    const inv = await invoice(wei);
    const snapshot = (await rpc('evm_snapshot')) as string;
    await send(inv.address, wei);
    await runCycle(deps());
    expect((await getInvoice(db, orgId, inv.id)).status).toBe('processing');

    expect(await rpc('evm_revert', [snapshot])).toBe(true);
    await mine(2);
    await runCycle(deps());
    expect((await getInvoice(db, orgId, inv.id)).status).toBe('open');
    expect(await balance()).toBe(1_234_567_890_123_456_789n); // unchanged by the withdrawn payment
  });
});
