/**
 * End to end against a real Bitcoin Core regtest node: confirmed wallet →
 * worker imports the address range and starts the cursor → invoice → real
 * payment → confirmations → credited.
 *
 * Requires UTXO_REGTEST_URL and UTXO_REGTEST_CHAIN=bitcoin (see chain-utxo).
 * Skipped otherwise. The regtest address prefix (bcrt1) differs from testnet
 * (tb1) only in its human-readable part, so a thin wrapper re-encodes it; the
 * witness program, which is what the node watches, is identical.
 */
import { randomBytes } from 'node:crypto';
import { bech32 } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BitcoinCoreAdapter,
  basicAuth,
  deriveUtxoAddress,
  jsonRpc,
  parseExtendedPublicKey,
  type IncomingTransfer,
  type ScanResult,
  type TransferCheck,
} from '@actualpay/chains';
import { inTransaction, type Db } from '@actualpay/database';
import { ensureAccount } from '@actualpay/ledger';
import { createInvoice, getInvoice, type InvoiceView } from '@actualpay/payments';
import { createLogger } from '@actualpay/shared';
import { confirmWallet, createWallet, deriveDeposit } from '@actualpay/wallets';
import { runCycle } from '@actualpay/watcher';
import { createOrganization, createTestDb, resetDatabase } from './helpers';

const rawUrl = process.env['UTXO_REGTEST_URL'];
const chain = process.env['UTXO_REGTEST_CHAIN'] ?? 'bitcoin';
const logger = createLogger({ name: 'test', level: 'silent' });
const meta = { requestId: 'test' };

/** bcrt1… ↔ tb1…: same witness program, different prefix. */
function reprefix(address: string, from: string, to: string): string {
  const decoded = bech32.decode(address as `${string}1${string}`);
  if (decoded.prefix !== from) return address;
  return bech32.encode(to, decoded.words);
}

const wrap = (t: IncomingTransfer): IncomingTransfer => ({
  ...t,
  toAddress: reprefix(t.toAddress, 'bcrt', 'tb'),
});

describe.skipIf(!rawUrl || chain !== 'bitcoin')('worker against bitcoind regtest', () => {
  const url = new URL(rawUrl ?? 'http://x:y@localhost:1');
  const base = `${url.protocol}//${url.host}`;
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  const auth = basicAuth(user, pass);
  const rpc = (method: string, params: unknown[] = [], wallet?: string) =>
    jsonRpc(wallet ? `${base}/wallet/${wallet}` : base, method, params, { headers: auth });

  const watchWallet = `ap_e2e_${randomBytes(4).toString('hex')}`;
  const minerWallet = `ap_e2eminer_${randomBytes(4).toString('hex')}`;
  const seed = randomBytes(32);
  const accountXpub = HDKey.fromMasterSeed(seed, {
    private: 0x04358394,
    public: 0x043587cf,
  }).derive("m/84'/1'/0'").publicExtendedKey;
  let db: Db;
  let orgId: string;
  let userId: string;
  let minerAddress: string;
  let adapter: WrappedAdapter;

  class WrappedAdapter extends BitcoinCoreAdapter {
    override async scanIncoming(cursor: string | null): Promise<ScanResult> {
      const result = await super.scanIncoming(cursor);
      return { ...result, transfers: result.transfers.map(wrap) };
    }
    override async recheck(ref: string): Promise<TransferCheck> {
      const result = await super.recheck(ref);
      return result.state === 'present'
        ? { state: 'present', transfer: wrap(result.transfer) }
        : result;
    }
  }

  const deps = () => ({
    db,
    logger,
    adapters: new Map([['bitcoin' as const, adapter]]),
    ownerId: 't',
  });
  const mine = (n: number) => rpc('generatetoaddress', [n, minerAddress]);
  const balance = () =>
    inTransaction(
      db,
      async (tx) =>
        (await ensureAccount(tx, { organizationId: orgId, assetId: 'btc', type: 'org_available' }))
          .balance,
    );
  const newInvoice = async (sats: bigint): Promise<InvoiceView> =>
    (
      await createInvoice(
        db,
        {
          organizationId: orgId,
          actor: { type: 'user', id: userId },
          assetId: 'btc',
          amount: sats,
          network: 'testnet',
          enabledAssets: ['btc'],
        },
        meta,
      )
    ).invoice;

  beforeAll(async () => {
    const info = (await rpc('getblockchaininfo')) as { chain: string };
    if (info.chain !== 'regtest') throw new Error('UTXO_REGTEST_URL must point at a regtest node');
    await rpc('createwallet', [minerWallet]);
    minerAddress = (await rpc('getnewaddress', ['', 'bech32'], minerWallet)) as string;
    await mine(101);

    adapter = new WrappedAdapter({
      chain: 'bitcoin',
      network: 'regtest',
      url: base,
      username: user,
      password: pass,
      walletName: watchWallet,
      requiredConfirmations: 3,
    });
    db = createTestDb();
    await resetDatabase(db);
    userId = (
      await db
        .insertInto('users')
        .values({
          email: 'e2e-utxo@example.test',
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
        chain: 'bitcoin',
        network: 'testnet',
        enabledChains: ['bitcoin'],
        label: 'e2e',
        accountXpub,
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
  });
  afterAll(async () => {
    await db.destroy();
  });

  it('issues no address until the node watches the range, then credits an exact payment', async () => {
    // Before the worker has imported anything, nothing may be issued.
    await expect(newInvoice(1n)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });

    const first = await runCycle(deps());
    expect(first.scans['bitcoin:testnet']).toEqual({ kind: 'initialised' });
    const wallet = await db
      .selectFrom('wallets')
      .select('watched_through')
      .where('organization_id', '=', orgId)
      .executeTakeFirstOrThrow();
    expect(Number(wallet.watched_through)).toBeGreaterThan(100);

    const sats = 1_234_567n;
    const inv = await newInvoice(sats);
    // Pay the same script on regtest (its address has the bcrt prefix).
    const regtestAddress = reprefix(inv.address, 'tb', 'bcrt');
    expect(regtestAddress).toBe(
      deriveUtxoAddress('bitcoin', 'regtest', parseExtendedPublicKey(accountXpub), 0),
    );
    await rpc('sendtoaddress', [regtestAddress, '0.01234567'], minerWallet);

    await runCycle(deps());
    expect((await getInvoice(db, orgId, inv.id)).status).toBe('processing'); // seen in the mempool
    expect(await balance()).toBe(0n);

    await mine(1);
    await runCycle(deps());
    expect((await getInvoice(db, orgId, inv.id)).status).toBe('processing'); // 1 of 3 confirmations
    await mine(2);
    await runCycle(deps());
    const paid = await getInvoice(db, orgId, inv.id);
    expect(paid.status).toBe('paid');
    expect(BigInt(paid.amount_confirmed)).toBe(sats);
    expect(await balance()).toBe(sats);
    await runCycle(deps());
    expect(await balance()).toBe(sats);
  });

  it('never issues from a wallet the node is not watching', async () => {
    const other = await createWallet(
      db,
      {
        organizationId: await createOrganization(db),
        actor: { type: 'user', id: userId },
        chain: 'bitcoin',
        network: 'testnet',
        enabledChains: ['bitcoin'],
        label: 'unwatched',
        accountXpub: HDKey.fromMasterSeed(randomBytes(32), {
          private: 0x04358394,
          public: 0x043587cf,
        }).derive("m/84'/1'/0'").publicExtendedKey,
      },
      meta,
    );
    const { allocateDepositAddress } = await import('@actualpay/wallets');
    await confirmWallet(
      db,
      {
        organizationId: other.wallet.organization_id,
        walletId: other.wallet.id,
        actor: { type: 'user', id: userId },
        address: deriveDeposit(other.wallet, 0).address,
      },
      meta,
    );
    await expect(
      allocateDepositAddress(db, {
        organizationId: other.wallet.organization_id,
        walletId: other.wallet.id,
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    // One worker cycle imports it, after which issuing works.
    await runCycle(deps());
    await expect(
      allocateDepositAddress(db, {
        organizationId: other.wallet.organization_id,
        walletId: other.wallet.id,
      }),
    ).resolves.toBeDefined();
  });
});
