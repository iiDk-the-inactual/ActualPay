/**
 * Ethereum adapter against a real EVM node (Anvil from Foundry).
 *
 * Requires EVM_TEST_RPC_URL pointing at a *local dev chain* (anvil, chain id
 * 31337) with unlocked accounts. Skipped otherwise. Never use a public
 * network: the test uses unlocked-account eth_sendTransaction and
 * evm_snapshot/evm_revert to simulate reorgs.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { EvmAdapter, jsonRpc, validateEvmAddress } from '@actualpay/chains';
import { TEST_TOKEN_BYTECODE } from '../fixtures/test-token';

const url = process.env['EVM_TEST_RPC_URL'];

const rpc = (method: string, params: unknown[] = []) => jsonRpc(url!, method, params);
const hex = (n: bigint) => `0x${n.toString(16)}`;
const word = (v: string | bigint) =>
  (typeof v === 'bigint' ? v.toString(16) : v.replace(/^0x/, '').toLowerCase()).padStart(64, '0');
const selector = (sig: string) =>
  Buffer.from(keccak_256(new TextEncoder().encode(sig)))
    .toString('hex')
    .slice(0, 8);

describe.skipIf(!url)('EVM adapter (anvil)', () => {
  let sender: string;
  let token: string;
  const watched = new Set<string>();
  const deposit = validateEvmAddress('0x' + 'ab'.repeat(20))!;
  const outsider = validateEvmAddress('0x' + 'cd'.repeat(20))!;
  let adapter: EvmAdapter;

  async function send(tx: Record<string, string>): Promise<string> {
    const hash = (await rpc('eth_sendTransaction', [{ from: sender, ...tx }])) as string;
    await rpc('evm_mine');
    return hash.toLowerCase();
  }

  beforeAll(async () => {
    const id = BigInt((await rpc('eth_chainId')) as string);
    if (id !== 31337n) throw new Error('EVM_TEST_RPC_URL must be a local anvil chain (31337)');
    await rpc('evm_setAutomine', [false]);
    sender = ((await rpc('eth_accounts')) as string[])[0]!;
    const deployHash = await send({ data: TEST_TOKEN_BYTECODE + word(10n ** 15n) });
    const receipt = (await rpc('eth_getTransactionReceipt', [deployHash])) as {
      contractAddress: string;
    };
    token = validateEvmAddress(receipt.contractAddress)!;
    watched.add(deposit);
    adapter = new EvmAdapter({
      network: 'testnet',
      url: url!,
      chainId: 31337n,
      token: { assetId: 'usdt-erc20', contract: token },
      watchedAddresses: () => Promise.resolve(watched),
      reorgOverlap: 4,
    });
  });

  it('refuses an endpoint on the wrong chain', async () => {
    const wrong = new EvmAdapter({
      network: 'mainnet',
      url: url!,
      chainId: 1n,
      watchedAddresses: () => Promise.resolve(new Set()),
    });
    await expect(wrong.status()).rejects.toThrow(/expected 1/);
  });

  it('detects native ETH and token transfers with exact amounts and per-log refs', async () => {
    const start = await adapter.scanIncoming(null);
    const ethHash = await send({ to: deposit, value: hex(1_234_567_890_123_456_789n) });
    await send({ to: outsider, value: hex(5n) });
    const t1 = await send({
      to: token,
      data: `0x${selector('transfer(address,uint256)')}${word(deposit)}${word(25_000_000n)}`,
    });
    const t2 = await send({
      to: token,
      data: `0x${selector('transferTwice(address,uint256,uint256)')}${word(deposit)}${word(1n)}${word(2n)}`,
    });

    const scan = await adapter.scanIncoming(start.cursor);
    const byRef = new Map(scan.transfers.map((t) => [t.ref, t]));
    expect(byRef.get(`eth:${ethHash}:native`)).toMatchObject({
      assetId: 'eth',
      amount: 1_234_567_890_123_456_789n,
      toAddress: deposit,
    });
    const tokens = scan.transfers.filter((t) => t.assetId === 'usdt-erc20');
    expect(tokens.map((t) => t.amount).sort()).toEqual([1n, 2n, 25_000_000n]);
    expect(tokens.find((t) => t.txHash === t1)!.ref).toMatch(new RegExp(`^eth:${t1}:[0-9]+$`));
    expect(new Set(tokens.filter((t) => t.txHash === t2).map((t) => t.ref)).size).toBe(2);
    expect(scan.transfers.some((t) => t.toAddress === outsider)).toBe(false);

    // Re-scanning from the same cursor is deterministic.
    expect((await adapter.scanIncoming(start.cursor)).transfers.map((t) => t.ref).sort()).toEqual(
      scan.transfers.map((t) => t.ref).sort(),
    );
  });

  it('ignores Transfer events from look-alike token contracts', async () => {
    const start = await adapter.scanIncoming(null);
    const fakeHash = await send({ data: TEST_TOKEN_BYTECODE + word(10n ** 9n) });
    const fake = (
      (await rpc('eth_getTransactionReceipt', [fakeHash])) as { contractAddress: string }
    ).contractAddress;
    const fakeTransfer = await send({
      to: fake,
      data: `0x${selector('transfer(address,uint256)')}${word(deposit)}${word(999n)}`,
    });
    // The scan re-reads a reorg overlap, so earlier transfers may reappear; the fake one must not.
    expect(
      (await adapter.scanIncoming(start.cursor)).transfers.filter((t) => t.txHash === fakeTransfer),
    ).toHaveLength(0);
  });

  it('ignores failed transactions', async () => {
    const start = await adapter.scanIncoming(null);
    // Transfer more than the balance from the deposit-unrelated sender to deposit: reverts.
    const failed = (
      (await rpc('eth_sendTransaction', [
        {
          from: sender,
          to: token,
          gas: '0x30000',
          data: `0x${selector('transfer(address,uint256)')}${word(deposit)}${word(10n ** 30n)}`,
        },
      ])) as string
    ).toLowerCase();
    // A failed native transfer to the deposit address as well (value > balance is rejected by
    // the node, so use a call that reverts while carrying value).
    await rpc('evm_mine');
    const receipt = (await rpc('eth_getTransactionReceipt', [failed])) as { status: string };
    expect(receipt.status).toBe('0x0');
    expect(
      (await adapter.scanIncoming(start.cursor)).transfers.filter((t) => t.txHash === failed),
    ).toHaveLength(0);
  });

  it('becomes final only at the node\u2019s finalized block', async () => {
    const hash = await send({ to: deposit, value: hex(7n) });
    const first = await adapter.recheck(`eth:${hash}:native`);
    expect(first.state).toBe('present');
    if (first.state !== 'present') return;
    expect(first.transfer.final).toBe(false);
    for (let i = 0; i < 80; i++) await rpc('evm_mine');
    const status = await adapter.status();
    const later = await adapter.recheck(`eth:${hash}:native`);
    expect(later.state === 'present' && later.transfer.final).toBe(
      first.transfer.blockHeight! <= status.finalHeight,
    );
    expect(status.finalHeight).toBeGreaterThanOrEqual(first.transfer.blockHeight!);
  });

  it('reports a transfer as missing after a reorg removes it', async () => {
    const snapshot = (await rpc('evm_snapshot')) as string;
    const hash = await send({ to: deposit, value: hex(9n) });
    expect((await adapter.recheck(`eth:${hash}:native`)).state).toBe('present');
    await rpc('evm_revert', [snapshot]);
    await rpc('evm_mine'); // a different block at the same height
    expect((await adapter.recheck(`eth:${hash}:native`)).state).toBe('missing');
  });

  it('validates refs and cursors', async () => {
    await expect(adapter.recheck('btc:00:0')).rejects.toThrow();
    await expect(adapter.scanIncoming('-1')).rejects.toThrow(/cursor/);
  });
});
