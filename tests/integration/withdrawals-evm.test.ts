/**
 * Withdrawals end to end against a real EVM node (Anvil): request → approve →
 * signer → broadcast → mined → settled, for native ETH and an ERC-20, plus a
 * transaction that reverts on chain.
 *
 * Requires EVM_TEST_RPC_URL pointing at a local anvil (chain id 31337).
 * Skipped otherwise. Never point this at a public network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EvmNode, jsonRpc, validateEvmAddress } from '@actualpay/chains';
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
import { TEST_TOKEN_BYTECODE } from '../fixtures/test-token';
import { createTestDb, resetDatabase } from './helpers';
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

const url = process.env['EVM_TEST_RPC_URL'];
const rpc = (method: string, params: unknown[] = []) => jsonRpc(url!, method, params);
const hex = (n: bigint) => `0x${n.toString(16)}`;
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const logger = createLogger({ name: 'test', level: 'silent' });
const ETH = 10n ** 18n;
const CFG: WithdrawalConfig = {
  custodyMode: 'platform',
  feeBps: 0,
  enabledAssets: ['eth', 'usdt-erc20'],
  network: 'testnet',
};

describe.skipIf(!url)('withdrawals against anvil', () => {
  let db: Db;
  let keystore: UnlockedKeystore;
  let node: EvmNode;
  let sender: string;
  let token: string;
  let f: Fixture;
  const outgoing = () => new Map([['ethereum' as const, node]]);
  const dest = validateEvmAddress('0x' + 'ef'.repeat(20)) as string;

  const mine = async (n = 1) => {
    for (let i = 0; i < n; i++) await rpc('evm_mine');
  };
  const send = async (tx: Record<string, string>) => {
    const hash = (await rpc('eth_sendTransaction', [{ from: sender, ...tx }])) as string;
    await mine();
    return hash.toLowerCase();
  };
  const ethBalanceOf = async (a: string) =>
    BigInt((await rpc('eth_getBalance', [a, 'latest'])) as string);
  const tokenBalanceOf = (a: string) => node.tokenBalance(token, a);

  beforeAll(async () => {
    const id = BigInt((await rpc('eth_chainId')) as string);
    if (id !== 31337n) throw new Error('EVM_TEST_RPC_URL must be a local anvil chain (31337)');
    await rpc('evm_setAutomine', [false]);
    sender = ((await rpc('eth_accounts')) as string[])[0]!;
    node = new EvmNode('testnet', url!, 31337n);
    db = createTestDb();
    keystore = unlockKeystore(
      createKeystore({ passphrase: 'a long test passphrase', network: 'testnet', scryptN: 2 ** 12 })
        .file,
      'a long test passphrase',
      { allowWeakKdf: true },
    );
    const deploy = await send({ data: TEST_TOKEN_BYTECODE + word(10n ** 12n) });
    const receipt = (await rpc('eth_getTransactionReceipt', [deploy])) as {
      contractAddress: string;
    };
    token = validateEvmAddress(receipt.contractAddress) as string;
    // Fund the hot wallet with gas money and tokens.
    await send({ to: keystore.addresses.ethereum, value: hex(50n * ETH) });
    await send({
      to: token,
      data: `0xa9059cbb${word(BigInt(keystore.addresses.ethereum))}${word(10n ** 9n)}`,
    });
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
        chain: 'ethereum',
        network: 'testnet',
        address: keystore.addresses.ethereum,
        label: 'hot',
        userId: f.adminId,
      },
      meta,
    );
  });

  async function approved(assetId: 'eth' | 'usdt-erc20', amount: bigint, destinationId: string) {
    const { withdrawal } = await requestWithdrawal(
      db,
      {
        organizationId: f.orgId,
        requester: { type: 'user', id: f.requesterId },
        assetId,
        amount,
        destinationId,
        config: CFG,
      },
      meta,
    );
    return approveWithdrawal(
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
  }
  const signerDeps = () => ({
    db,
    logger,
    keystore,
    sealKey: SEAL_KEY,
    network: 'testnet' as const,
    evm: node,
    utxo: {},
    tokenContracts: { 'usdt-erc20': token },
  });
  const row = (id: string) =>
    db.selectFrom('withdrawals').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const custody = async (assetId: string) =>
    BigInt(
      (
        await db
          .selectFrom('ledger_accounts')
          .select('balance')
          .where('asset_id', '=', assetId)
          .where('type', '=', 'custody')
          .executeTakeFirstOrThrow()
      ).balance,
    );

  it('sends native ETH to the approved address and settles the ledger with the real fee', async () => {
    await seedBalance(db, f.orgId, 'eth', 10n * ETH);
    await seedPlatformFunds(db, 'eth', ETH);
    await enablePolicy(db, f, 'eth', { perWithdrawal: 5n * ETH, perDay: 8n * ETH });
    const d = await usableDestination(db, f, 'ethereum', dest);
    const w = await approved('eth', 2n * ETH, d.id);

    const before = await ethBalanceOf(dest);
    expect((await signApprovedWithdrawals(signerDeps())).signed).toEqual([w.id]);
    const signed = await row(w.id);
    expect(signed.status).toBe('signed');
    expect(signed.txid).toMatch(/^0x[0-9a-f]{64}$/);

    await broadcastSigned({ db, outgoing: outgoing(), logger });
    expect((await row(w.id)).status).toBe('broadcast');
    await mine(2);
    await trackBroadcasts({ db, outgoing: outgoing(), logger });
    // Run until finality; anvil finalizes after enough blocks.
    await mine(70);
    await trackBroadcasts({ db, outgoing: outgoing(), logger });

    const done = await row(w.id);
    expect(done.status).toBe('confirmed');
    expect(await ethBalanceOf(dest)).toBe(before + 2n * ETH);
    expect(BigInt(done.final_network_fee!)).toBeGreaterThan(0n);
    // Custody shrank by the amount plus the real fee, which equals what the chain charged.
    const receipt = (await rpc('eth_getTransactionReceipt', [done.txid!])) as {
      gasUsed: string;
      effectiveGasPrice: string;
    };
    expect(BigInt(done.final_network_fee!)).toBe(
      BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice),
    );
    expect(await custody('eth')).toBe(11n * ETH - 2n * ETH - BigInt(done.final_network_fee!));
  });

  it('sends an ERC-20 as a transfer() call', async () => {
    await seedBalance(db, f.orgId, 'usdt-erc20', 500_000_000n);
    await seedPlatformFunds(db, 'eth', ETH);
    await seedBalance(db, f.orgId, 'eth', ETH); // gives custody ETH to absorb the fee
    await enablePolicy(db, f, 'usdt-erc20', { perWithdrawal: 400_000_000n, perDay: 450_000_000n });
    const d = await usableDestination(db, f, 'ethereum', dest);
    const w = await approved('usdt-erc20', 123_456_789n, d.id);

    const before = await tokenBalanceOf(dest);
    expect((await signApprovedWithdrawals(signerDeps())).signed).toEqual([w.id]);
    await broadcastSigned({ db, outgoing: outgoing(), logger });
    await mine(2);
    await mine(70);
    await trackBroadcasts({ db, outgoing: outgoing(), logger });
    await trackBroadcasts({ db, outgoing: outgoing(), logger });

    expect((await row(w.id)).status).toBe('confirmed');
    expect(await tokenBalanceOf(dest)).toBe(before + 123_456_789n);
  });
});
