/**
 * Bitcoin withdrawals end to end against Bitcoin Core regtest: the signer
 * spends the hot wallet's coins, the node accepts and mines the transaction
 * (so the hand-built BIP143 signature is valid), and the ledger settles.
 *
 * Requires UTXO_REGTEST_URL and UTXO_REGTEST_CHAIN=bitcoin. Skipped otherwise.
 * Regtest addresses use bcrt1…; the app's testnet uses tb1… with the same
 * witness program, so the node wrapper re-encodes the prefix.
 */
import { randomBytes } from 'node:crypto';
import { bech32 } from '@scure/base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { basicAuth, jsonRpc, UtxoNode, type Utxo } from '@actualpay/chains';
import type { Db } from '@actualpay/database';
import { createLogger } from '@actualpay/shared';
import {
  createKeystore,
  signApprovedWithdrawals,
  unlockKeystore,
  type UnlockedKeystore,
} from '@actualpay/signer';
import {
  approveWithdrawal,
  broadcastSigned,
  registerHotWallet,
  requestWithdrawal,
  trackBroadcasts,
  type WithdrawalConfig,
} from '@actualpay/withdrawals';
import { createTestDb, eventually, resetDatabase, sharedRegtestMiner } from './helpers';
import {
  enablePolicy,
  meta,
  orgWithPeople,
  seedBalance,
  seedPlatformFunds,
  SEAL_KEY,
  usableDestination,
  type Fixture,
} from './withdrawal-helpers';

const rawUrl = process.env['UTXO_REGTEST_URL'];
const chain = process.env['UTXO_REGTEST_CHAIN'] ?? 'bitcoin';
const logger = createLogger({ name: 'test', level: 'silent' });
const CFG: WithdrawalConfig = {
  custodyMode: 'platform',
  feeBps: 0,
  enabledAssets: ['btc'],
  network: 'testnet',
};

function reprefix(address: string, to: string): string {
  const decoded = bech32.decode(address as `${string}1${string}`);
  return bech32.encode(to, decoded.words);
}

describe.skipIf(!rawUrl || chain !== 'bitcoin')('withdrawals against bitcoind regtest', () => {
  const url = new URL(rawUrl ?? 'http://x:y@localhost:1');
  const base = `${url.protocol}//${url.host}`;
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  const auth = basicAuth(user, pass);
  const rpc = (method: string, params: unknown[] = [], wallet?: string) =>
    jsonRpc(wallet ? `${base}/wallet/${wallet}` : base, method, params, { headers: auth });
  let minerWallet = '';
  const receiverWallet = `ap_wd_recv_${randomBytes(4).toString('hex')}`;

  class RegtestNode extends UtxoNode {
    override ensureHotWallet(address: string): Promise<void> {
      return super.ensureHotWallet(reprefix(address, 'bcrt'));
    }
    override async listUnspent(address: string, min = 1): Promise<Utxo[]> {
      return super.listUnspent(reprefix(address, 'bcrt'), min);
    }
  }

  let db: Db;
  let keystore: UnlockedKeystore;
  let node: RegtestNode;
  let f: Fixture;
  let minerAddress: string;
  let receiverAddress: string;
  const mine = (n: number) => rpc('generatetoaddress', [n, minerAddress]);

  beforeAll(async () => {
    const info = (await rpc('getblockchaininfo')) as { chain: string };
    if (info.chain !== 'regtest') throw new Error('UTXO_REGTEST_URL must point at a regtest node');
    await rpc('createwallet', [receiverWallet]);
    receiverAddress = (await rpc('getnewaddress', ['', 'bech32'], receiverWallet)) as string;
    ({ wallet: minerWallet, address: minerAddress } = await sharedRegtestMiner(
      (m, p, w) => rpc(m, p, w),
      0.1,
    ));
    keystore = unlockKeystore(
      createKeystore({ passphrase: 'a long test passphrase', network: 'testnet', scryptN: 2 ** 12 })
        .file,
      'a long test passphrase',
      { allowWeakKdf: true },
    );
    node = new RegtestNode({
      chain: 'bitcoin',
      network: 'testnet',
      url: base,
      username: user,
      password: pass,
      walletName: `ap_wd_${randomBytes(4).toString('hex')}`,
      requiredConfirmations: 3,
    });
    await node.ensureHotWallet(keystore.addresses.bitcoin);
    // Fund the hot wallet with two coins.
    const hot = reprefix(keystore.addresses.bitcoin, 'bcrt');
    await rpc('sendtoaddress', [hot, 0.02], minerWallet);
    await rpc('sendtoaddress', [hot, 0.02], minerWallet);
    await mine(2);
    db = createTestDb();
  });
  afterAll(async () => {
    keystore.lock();
    await db.destroy();
  });
  beforeEach(async () => {
    await resetDatabase(db);
    f = await orgWithPeople(db);
    await registerHotWallet(
      db,
      {
        chain: 'bitcoin',
        network: 'testnet',
        address: keystore.addresses.bitcoin,
        label: 'hot',
        userId: f.adminId,
      },
      meta,
    );
  });

  it('builds a transaction Bitcoin Core accepts, mines, and settles', async () => {
    await eventually(async () => (await node.listUnspent(keystore.addresses.bitcoin)).length >= 2);
    await seedBalance(db, f.orgId, 'btc', 3_000_000n);
    await seedPlatformFunds(db, 'btc', 100_000n);
    await enablePolicy(db, f, 'btc', { perWithdrawal: 2_000_000n, perDay: 2_500_000n });
    // The ledger knows testnet addresses; the node is paid at the bcrt1 form of the same program.
    const dest = reprefix(receiverAddress, 'tb');
    const d = await usableDestination(db, f, 'bitcoin', dest);
    const { withdrawal } = await requestWithdrawal(
      db,
      {
        organizationId: f.orgId,
        requester: { type: 'user', id: f.requesterId },
        assetId: 'btc',
        amount: 1_000_000n,
        destinationId: d.id,
        config: CFG,
      },
      meta,
    );
    await approveWithdrawal(
      db,
      {
        organizationId: f.orgId,
        withdrawalId: withdrawal.id,
        approverUserId: f.approverId,
        sealKey: SEAL_KEY,
        approvalTtlMinutes: 60,
      },
      meta,
    );

    const report = await signApprovedWithdrawals({
      db,
      logger,
      keystore,
      sealKey: SEAL_KEY,
      network: 'testnet',
      utxo: { bitcoin: node },
      tokenContracts: {},
    });
    expect(report.refused).toEqual([]);
    expect(report.signed).toEqual([withdrawal.id]);

    const outgoing = new Map([['bitcoin' as const, node]]);
    await broadcastSigned({ db, outgoing, logger });
    const signed = await db
      .selectFrom('withdrawals')
      .selectAll()
      .where('id', '=', withdrawal.id)
      .executeTakeFirstOrThrow();
    expect(signed.status).toBe('broadcast');
    // The node's own mempool has it: the signature and encoding are valid.
    const entry = (await rpc('getmempoolentry', [signed.txid!])) as { vsize: string | number };
    expect(Number(entry.vsize)).toBeGreaterThan(0);

    await mine(4);
    await eventually(async () => {
      await trackBroadcasts({ db, outgoing, logger });
      const r = await db
        .selectFrom('withdrawals')
        .select('status')
        .where('id', '=', withdrawal.id)
        .executeTakeFirstOrThrow();
      return r.status === 'confirmed';
    });
    const received = (await rpc('getreceivedbyaddress', [receiverAddress, 1], receiverWallet)) as
      string | number;
    expect(Number(received)).toBeGreaterThanOrEqual(0.01);
  });
});
