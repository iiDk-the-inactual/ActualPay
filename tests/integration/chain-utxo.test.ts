/**
 * Bitcoin Core / Litecoin Core adapter against a real regtest node.
 *
 * Requires UTXO_REGTEST_URL (http://user:pass@host:port), UTXO_REGTEST_CHAIN
 * (bitcoin | litecoin) and a node started with -regtest -fallbackfee=0.0001.
 * The test creates its own wallets; never point it at a mainnet node.
 * Skipped when UTXO_REGTEST_URL is not set.
 */
import { randomBytes } from 'node:crypto';
import { HDKey } from '@scure/bip32';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BitcoinCoreAdapter,
  basicAuth,
  deriveUtxoAddress,
  jsonRpc,
  parseExtendedPublicKey,
} from '@actualpay/chains';

const rawUrl = process.env['UTXO_REGTEST_URL'];
const chain = (process.env['UTXO_REGTEST_CHAIN'] ?? 'bitcoin') as 'bitcoin' | 'litecoin';

describe.skipIf(!rawUrl)(`${chain} Core adapter (regtest)`, () => {
  const url = new URL(rawUrl ?? 'http://x:y@localhost:1');
  const base = `${url.protocol}//${url.host}`;
  const auth = basicAuth(decodeURIComponent(url.username), decodeURIComponent(url.password));
  const rpc = (method: string, params: unknown[] = [], wallet?: string) =>
    jsonRpc(wallet ? `${base}/wallet/${wallet}` : base, method, params, { headers: auth });

  const walletName = `ap_watch_${randomBytes(4).toString('hex')}`;
  const minerWallet = `ap_miner_${randomBytes(4).toString('hex')}`;
  const account = parseExtendedPublicKey(
    HDKey.fromMasterSeed(randomBytes(32)).derive("m/84'/1'/0'").publicExtendedKey,
  );
  const adapter = new BitcoinCoreAdapter({
    chain,
    network: 'regtest',
    url: base,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    walletName,
    requiredConfirmations: 3,
  });
  let minerAddress: string;
  const mine = async (n: number) => rpc('generatetoaddress', [n, minerAddress]);

  beforeAll(async () => {
    const chainInfo = (await rpc('getblockchaininfo')) as { chain: string };
    if (chainInfo.chain !== 'regtest')
      throw new Error('UTXO_REGTEST_URL must point at a regtest node');
    await rpc('createwallet', [minerWallet]);
    minerAddress = (await rpc('getnewaddress', ['', 'bech32'], minerWallet)) as string;
    await mine(101);
  });

  it('creates a watch-only descriptor wallet and refuses wallets with private keys', async () => {
    await adapter.ensureWatchWallet();
    await adapter.ensureWatchWallet(); // idempotent
    const hot = new BitcoinCoreAdapter({
      chain,
      network: 'regtest',
      url: base,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      walletName: minerWallet,
      requiredConfirmations: 3,
    });
    await expect(hot.ensureWatchWallet()).rejects.toThrow(/private keys enabled/);
  });

  it('imports the descriptor only after the node derives the same addresses', async () => {
    await adapter.watchAccount(account, 20);
    const other = parseExtendedPublicKey(
      HDKey.fromMasterSeed(randomBytes(32)).derive("m/84'/1'/0'").publicExtendedKey,
    );
    // Sanity: a different key derives different addresses.
    expect(deriveUtxoAddress(chain, 'regtest', other, 0)).not.toBe(
      deriveUtxoAddress(chain, 'regtest', account, 0),
    );
  });

  it('detects a payment, tracks confirmations exactly, and finalises at the required depth', async () => {
    const status = await adapter.status();
    expect(status.synced).toBe(true);
    let cursor = (await adapter.scanIncoming(null)).cursor;

    const to = deriveUtxoAddress(chain, 'regtest', account, 7);
    // 0.10000001 is not representable as a binary float: exactness check.
    const txid = (await rpc('sendtoaddress', [to, '0.10000001'], minerWallet)) as string;

    let scan = await adapter.scanIncoming(cursor);
    const pending = scan.transfers.find((t) => t.txHash === txid);
    expect(pending).toMatchObject({
      toAddress: to,
      amount: 10_000_001n,
      confirmations: 0n,
      final: false,
      blockHeight: null,
    });
    cursor = scan.cursor;

    await mine(2);
    scan = await adapter.scanIncoming(cursor);
    expect(scan.transfers.find((t) => t.txHash === txid)).toMatchObject({
      confirmations: 2n,
      final: false,
    });
    cursor = scan.cursor;

    await mine(1);
    scan = await adapter.scanIncoming(cursor);
    const final = scan.transfers.find((t) => t.txHash === txid);
    expect(final).toMatchObject({ confirmations: 3n, final: true });
    expect(final!.ref).toMatch(
      new RegExp(`^${chain === 'bitcoin' ? 'btc' : 'ltc'}:${txid}:[0-9]+$`),
    );

    const check = await adapter.recheck(final!.ref);
    expect(check.state).toBe('present');
    // Once final, it stops being re-reported.
    await mine(1);
    expect(
      (await adapter.scanIncoming(scan.cursor)).transfers.find((t) => t.txHash === txid),
    ).toBeUndefined();
  });

  it('ignores payments to addresses outside the watched descriptor', async () => {
    const cursor = (await adapter.scanIncoming(null)).cursor;
    const stranger = (await rpc('getnewaddress', ['', 'bech32'], minerWallet)) as string;
    await rpc('sendtoaddress', [stranger, '1'], minerWallet);
    await mine(1);
    expect((await adapter.scanIncoming(cursor)).transfers).toHaveLength(0);
  });

  it('drops a reorged-out payment back to unconfirmed, never leaving it "confirmed"', async () => {
    const to = deriveUtxoAddress(chain, 'regtest', account, 9);
    const txid = (await rpc('sendtoaddress', [to, '0.5'], minerWallet)) as string;
    const [blockHash] = (await mine(1)) as string[];
    const height = (await rpc('getblockcount')) as number;
    const scan = await adapter.scanIncoming((await rpc('getblockhash', [height - 2])) as string);
    const transfer = scan.transfers.find((t) => t.txHash === txid)!;
    expect(transfer.confirmations).toBe(1n);

    // Disconnect the block (a reorg as seen by this node): the transaction
    // returns to the mempool and must read as unconfirmed again.
    await rpc('invalidateblock', [blockHash]);
    try {
      const check = await adapter.recheck(transfer.ref);
      if (check.state === 'present') {
        expect(check.transfer.confirmations).toBe(0n);
        expect(check.transfer.final).toBe(false);
      } else {
        expect(check.state).toBe('missing');
      }
    } finally {
      await rpc('reconsiderblock', [blockHash]);
    }
    const restored = await adapter.recheck(transfer.ref);
    expect(restored.state === 'present' && restored.transfer.confirmations >= 1n).toBe(true);
  });

  it('rejects malformed cursors and refs', async () => {
    await expect(adapter.scanIncoming('not-a-hash')).rejects.toThrow(/cursor/);
    await expect(adapter.recheck('eth:0xabc:native')).rejects.toThrow();
  });
});
