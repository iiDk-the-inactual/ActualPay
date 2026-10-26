/**
 * The signer's independent checks and transaction building, against fake nodes.
 * (tests/integration/withdrawals-evm.test.ts and -utxo.test.ts run the same code
 * against real Anvil and Bitcoin Core nodes.)
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { validateEvmAddress, type EvmNode, type Utxo, type UtxoNode } from '@actualpay/chains';
import { inTransaction, type Db } from '@actualpay/database';
import { postWithdrawalRelease } from '@actualpay/ledger';
import { createLogger, type AssetId } from '@actualpay/shared';
import {
  createKeystore,
  decodeEip1559,
  parseUtxoTx,
  recoverSender,
  signApprovedWithdrawals,
  unlockKeystore,
  type SignerDeps,
  type UnlockedKeystore,
} from '@actualpay/signer';
import {
  approveWithdrawal,
  cancelWithdrawal,
  registerHotWallet,
  requestWithdrawal,
  retireHotWallet,
  revokeDestination,
  setPolicy,
  setWithdrawalsPaused,
  type WithdrawalConfig,
} from '@actualpay/withdrawals';
import { createTestDb, resetDatabase } from './helpers';
import {
  addMember,
  createUser,
  enablePolicy,
  meta,
  orgWithPeople,
  seedBalance,
  SEAL_KEY,
  usableDestination,
  type Fixture,
} from './withdrawal-helpers';

const logger = createLogger({ name: 'test', level: 'silent' });
const ETH = 10n ** 18n;
const TOKEN = validateEvmAddress('0x' + '77'.repeat(20)) as string;
const DEST = validateEvmAddress('0x' + 'cd'.repeat(20)) as string;
const BTC_DEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const CFG: WithdrawalConfig = {
  custodyMode: 'platform',
  feeBps: 0,
  enabledAssets: ['eth', 'btc', 'usdt-erc20'],
  network: 'testnet',
};

let db: Db;
let keystore: UnlockedKeystore;
let f: Fixture;
let ethDest: string;

class FakeEvm {
  chainId = 31337n;
  nodeNonce = 5n;
  baseFee = 1_000_000_000n;
  priority = 1_000_000_000n;
  gas = 21_000n;
  ethBalance = 100n * ETH;
  tokenBalanceValue = 1_000_000_000n;
  verifyChain(): Promise<void> {
    return Promise.resolve();
  }
  call(method: string): Promise<unknown> {
    if (method === 'eth_chainId') return Promise.resolve(`0x${this.chainId.toString(16)}`);
    return Promise.reject(new Error(`unexpected ${method}`));
  }
  feeData() {
    return Promise.resolve({ baseFee: this.baseFee, priorityFee: this.priority });
  }
  nonce() {
    return Promise.resolve(this.nodeNonce);
  }
  estimateGas() {
    return Promise.resolve(this.gas);
  }
  balance() {
    return Promise.resolve(this.ethBalance);
  }
  tokenBalance() {
    return Promise.resolve(this.tokenBalanceValue);
  }
}

class FakeUtxo {
  coins: Utxo[] = [];
  rate = 5n;
  ensured: string[] = [];
  ensureHotWallet(address: string): Promise<void> {
    this.ensured.push(address);
    return Promise.resolve();
  }
  feeRate() {
    return Promise.resolve(this.rate);
  }
  listUnspent() {
    return Promise.resolve(this.coins);
  }
}

let evm: FakeEvm;
let utxo: FakeUtxo;

beforeAll(() => {
  db = createTestDb();
  keystore = unlockKeystore(
    createKeystore({ passphrase: 'a long test passphrase', network: 'testnet', scryptN: 2 ** 12 })
      .file,
    'a long test passphrase',
    { allowWeakKdf: true },
  );
});
afterAll(async () => {
  keystore.lock();
  await db.destroy();
});
beforeEach(async () => {
  await resetDatabase(db);
  f = await orgWithPeople(db);
  ethDest = (await usableDestination(db, f, 'ethereum', DEST)).id;
  await seedBalance(db, f.orgId, 'eth', 10n * ETH);
  await seedBalance(db, f.orgId, 'usdt-erc20', 1_000_000_000n);
  await enablePolicy(db, f, 'eth', { min: 1n, perWithdrawal: 5n * ETH, perDay: 8n * ETH });
  await enablePolicy(db, f, 'usdt-erc20', {
    min: 1n,
    perWithdrawal: 500_000_000n,
    perDay: 900_000_000n,
  });
  for (const chain of ['ethereum', 'bitcoin'] as const)
    await registerHotWallet(
      db,
      {
        chain,
        network: 'testnet',
        address: keystore.addresses[chain],
        label: 'hot',
        userId: f.adminId,
      },
      meta,
    );
  evm = new FakeEvm();
  utxo = new FakeUtxo();
});

const deps = (over: Partial<SignerDeps> = {}): SignerDeps => ({
  db,
  logger,
  keystore,
  sealKey: SEAL_KEY,
  network: 'testnet',
  evm: evm as unknown as EvmNode,
  utxo: { bitcoin: utxo as unknown as UtxoNode },
  tokenContracts: { 'usdt-erc20': TOKEN },
  ...over,
});

async function approved(
  opts: { asset?: AssetId; amount?: bigint; destination?: string; btc?: boolean } = {},
) {
  const asset = opts.asset ?? 'eth';
  const { withdrawal } = await requestWithdrawal(
    db,
    {
      organizationId: f.orgId,
      requester: { type: 'user', id: f.requesterId },
      assetId: asset,
      amount: opts.amount ?? ETH,
      destinationId: opts.destination ?? ethDest,
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
const row = (id: string) =>
  db.selectFrom('withdrawals').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

async function expectRefused(id: string, reason: RegExp, over: Partial<SignerDeps> = {}) {
  const report = await signApprovedWithdrawals(deps(over));
  expect(report.signed).toEqual([]);
  expect(report.refused.map((r) => r.reason).join('\n')).toMatch(reason);
  const r = await row(id);
  expect(r.status).toBe('approved');
  expect(r.signed_tx).toBeNull();
  expect(r.last_error).toMatch(/signing refused/);
}

describe('building and signing', () => {
  it('signs a native ETH withdrawal from the hot wallet to exactly the approved destination', async () => {
    const w = await approved();
    const report = await signApprovedWithdrawals(deps());
    expect(report.signed).toEqual([w.id]);
    const r = await row(w.id);
    expect(r.status).toBe('signed');
    expect(r.hot_address).toBe(keystore.addresses.ethereum);
    expect(r.nonce).toBe('5');
    expect(r.txid).toMatch(/^0x[0-9a-f]{64}$/);
    expect(recoverSender(r.signed_tx!)).toBe(keystore.addresses.ethereum);
    const tx = decodeEip1559(r.signed_tx!);
    expect(tx).toMatchObject({
      to: DEST.toLowerCase(),
      value: ETH,
      data: '0x',
      nonce: 5n,
      chainId: 31337n,
      gasLimit: 21_000n,
    });
    expect(tx.maxFeePerGas).toBe(evm.baseFee * 2n + evm.priority);
    expect(BigInt(r.planned_network_fee!)).toBe(21_000n * tx.maxFeePerGas);
    const audit = await db
      .selectFrom('audit_log')
      .select('action')
      .where('target_id', '=', w.id)
      .execute();
    expect(audit.map((a) => a.action)).toContain('withdrawal.signed');
  });

  it('signs an ERC-20 withdrawal as a transfer() call on the token contract', async () => {
    evm.gas = 50_000n;
    const w = await approved({ asset: 'usdt-erc20', amount: 250_000_000n });
    await signApprovedWithdrawals(deps());
    const tx = decodeEip1559((await row(w.id)).signed_tx!);
    expect(tx.to).toBe(TOKEN.toLowerCase());
    expect(tx.value).toBe(0n);
    expect(tx.data.startsWith('0xa9059cbb')).toBe(true);
    expect(tx.data).toContain(DEST.slice(2).toLowerCase());
    expect(BigInt(`0x${tx.data.slice(-64)}`)).toBe(250_000_000n);
    expect(tx.gasLimit).toBe((50_000n * 13n) / 10n);
  });

  it('never reuses a nonce, even while the node still reports the old one', async () => {
    await approved({ amount: ETH / 2n });
    await approved({ amount: ETH / 2n });
    await approved({ amount: ETH / 2n });
    await signApprovedWithdrawals(deps());
    const nonces = (
      await db
        .selectFrom('withdrawals')
        .select('nonce')
        .where('status', '=', 'signed')
        .orderBy('nonce')
        .execute()
    ).map((r) => r.nonce);
    expect(nonces).toEqual(['5', '6', '7']);
    // The node later reports a higher count (they were mined): the next one follows it.
    evm.nodeNonce = 20n;
    const w = await approved({ amount: ETH / 2n });
    await signApprovedWithdrawals(deps());
    expect((await row(w.id)).nonce).toBe('20');
  });

  it('is safe when two signers run at the same moment', async () => {
    const ids = [
      (await approved({ amount: ETH / 2n })).id,
      (await approved({ amount: ETH / 2n })).id,
      (await approved({ amount: ETH / 2n })).id,
      (await approved({ amount: ETH / 2n })).id,
    ];
    await Promise.all([
      signApprovedWithdrawals(deps()),
      signApprovedWithdrawals(deps()),
      signApprovedWithdrawals(deps()),
    ]);
    const rows = await Promise.all(ids.map(row));
    expect(rows.map((r) => r.status)).toEqual(['signed', 'signed', 'signed', 'signed']);
    expect(new Set(rows.map((r) => r.nonce)).size).toBe(4);
    expect(new Set(rows.map((r) => r.txid)).size).toBe(4);
  });

  it('freezes the signed transaction and ends cancellation', async () => {
    const w = await approved();
    await signApprovedWithdrawals(deps());
    await expect(
      cancelWithdrawal(
        db,
        { organizationId: f.orgId, withdrawalId: w.id, userId: f.requesterId },
        meta,
      ),
    ).rejects.toThrow(/already be on its way/);
    await expect(
      db.updateTable('withdrawals').set({ signed_tx: '0x02aa' }).where('id', '=', w.id).execute(),
    ).rejects.toThrow(/signed transaction cannot be changed/);
    // A second pass does nothing to it.
    expect((await signApprovedWithdrawals(deps())).signed).toEqual([]);
  });
});

describe('the signer refuses what it should not sign', () => {
  it('while withdrawals are paused', async () => {
    const w = await approved();
    await setWithdrawalsPaused(db, { paused: true, reason: 'incident', userId: f.adminId }, meta);
    await expectRefused(w.id, /paused/);
    await setWithdrawalsPaused(db, { paused: false, userId: f.adminId }, meta);
    expect((await signApprovedWithdrawals(deps())).signed).toEqual([w.id]);
  });

  it('when the approved terms were edited behind the API (the seal catches it)', async () => {
    const w = await approved();
    await sql`ALTER TABLE withdrawals DISABLE TRIGGER withdrawals_guard`.execute(db);
    try {
      await db
        .updateTable('withdrawals')
        .set({ destination_address: validateEvmAddress('0x' + 'ee'.repeat(20)) as string })
        .where('id', '=', w.id)
        .execute();
    } finally {
      await sql`ALTER TABLE withdrawals ENABLE TRIGGER withdrawals_guard`.execute(db);
    }
    await expectRefused(w.id, /seal does not verify/);
  });

  it('when the seal key is wrong or the seal was forged', async () => {
    const w = await approved();
    await expectRefused(w.id, /seal does not verify/, { sealKey: Buffer.alloc(32, 1) });
  });

  it('when the approval has expired', async () => {
    const w = await approved();
    await expectRefused(w.id, /expired/, { now: new Date(Date.now() + 2 * 3_600_000) });
  });

  it('when the approver no longer has rights or lost two-factor authentication', async () => {
    const w = await approved();
    const spare = await createUser(db, 'spare-owner');
    await addMember(db, f.orgId, spare, 'owner', true);
    await db
      .updateTable('organization_members')
      .set({ role: 'viewer' })
      .where('user_id', '=', f.approverId)
      .execute();
    await expectRefused(w.id, /no longer has approval rights/);
    await db
      .updateTable('organization_members')
      .set({ role: 'owner' })
      .where('user_id', '=', f.approverId)
      .execute();
    await db.deleteFrom('totp_credentials').where('user_id', '=', f.approverId).execute();
    await expectRefused(w.id, /two-factor/);
  });

  it('when the held funds were released, or the hold never existed', async () => {
    const w = await approved();
    await inTransaction(db, (tx) =>
      postWithdrawalRelease(tx, {
        organizationId: f.orgId,
        assetId: 'eth',
        withdrawalId: w.id,
        total: BigInt(w.amount) + BigInt(w.fee_charged),
      }),
    );
    await expectRefused(w.id, /already released/);

    const second = await approved({ amount: ETH / 2n });
    await sql`ALTER TABLE withdrawals DISABLE TRIGGER withdrawals_guard`.execute(db);
    try {
      const other = await db
        .selectFrom('ledger_journals')
        .select('id')
        .where('kind', '=', 'deposit_confirmed')
        .limit(1)
        .executeTakeFirstOrThrow();
      await db
        .updateTable('withdrawals')
        .set({ hold_journal_id: other.id })
        .where('id', '=', second.id)
        .execute();
    } finally {
      await sql`ALTER TABLE withdrawals ENABLE TRIGGER withdrawals_guard`.execute(db);
    }
    const report = await signApprovedWithdrawals(deps());
    expect(report.refused.map((r) => r.id)).toContain(second.id);
  });

  it('when the destination was revoked or the policy was tightened after approval', async () => {
    const w = await approved();
    await revokeDestination(
      db,
      { organizationId: f.orgId, destinationId: ethDest, userId: f.approverId },
      meta,
    );
    await expectRefused(w.id, /destination was revoked/);

    const other = await usableDestination(
      db,
      f,
      'ethereum',
      validateEvmAddress('0x' + '99'.repeat(20)) as string,
      'second',
    );
    const w2 = await approved({ destination: other.id, amount: 2n * ETH });
    await setPolicy(
      db,
      {
        organizationId: f.orgId,
        assetId: 'eth',
        userId: f.approverId,
        enabled: true,
        minAmount: 1n,
        maxPerWithdrawal: ETH,
        maxPerDay: 2n * ETH,
        increaseDelayHours: 24,
      },
      meta,
    );
    const report = await signApprovedWithdrawals(deps());
    expect(report.refused.find((r) => r.id === w2.id)?.reason).toMatch(/policy/);
  });

  it('when the destination was still cooling down at approval time', async () => {
    const w = await approved();
    await sql`ALTER TABLE withdrawal_destinations DISABLE TRIGGER withdrawal_destinations_guard`.execute(
      db,
    );
    try {
      await db
        .updateTable('withdrawal_destinations')
        .set({ active_at: new Date(Date.now() + 3_600_000) } as never)
        .where('id', '=', ethDest)
        .execute();
    } finally {
      await sql`ALTER TABLE withdrawal_destinations ENABLE TRIGGER withdrawal_destinations_guard`.execute(
        db,
      );
    }
    await expectRefused(w.id, /cool-down/);
  });

  it('when the hot wallet is not registered, is retired, or belongs to another keystore', async () => {
    const w = await approved();
    const wallet = await db
      .selectFrom('hot_wallets')
      .select('id')
      .where('chain', '=', 'ethereum')
      .executeTakeFirstOrThrow();
    await retireHotWallet(db, { hotWalletId: wallet.id, userId: f.adminId }, meta);
    await expectRefused(w.id, /hot wallet is not registered/);
    const stranger = unlockKeystore(
      createKeystore({
        passphrase: 'another long passphrase!',
        network: 'testnet',
        scryptN: 2 ** 12,
      }).file,
      'another long passphrase!',
      { allowWeakKdf: true },
    );
    await expectRefused(w.id, /hot wallet is not registered/, { keystore: stranger });
  });

  it('on a runaway gas price, an underfunded hot wallet, or fees that dwarf the amount', async () => {
    const w = await approved();
    evm.baseFee = 400_000_000_000n; // 2×400 + 1 gwei > the 500 gwei cap
    await expectRefused(w.id, /safety cap/);
    evm.baseFee = 1_000_000_000n;
    evm.ethBalance = ETH / 2n;
    await expectRefused(w.id, /holds too little ETH/);
    evm.ethBalance = 100n * ETH;
    const tiny = await approved({ amount: 1_000n });
    const report = await signApprovedWithdrawals(deps());
    expect(report.refused.find((r) => r.id === tiny.id)?.reason).toMatch(/fee is too large/);
    expect(report.signed).toContain(w.id);
  });

  it('for a token the hot wallet cannot cover, or one with no configured contract', async () => {
    evm.gas = 50_000n;
    const w = await approved({ asset: 'usdt-erc20', amount: 100_000_000n });
    evm.tokenBalanceValue = 10n;
    await expectRefused(w.id, /too little of the token/);
    evm.tokenBalanceValue = 1_000_000_000n;
    await expectRefused(w.id, /no contract is configured/, { tokenContracts: {} });
  });

  it('when no node is configured for the chain', async () => {
    const w = await approved();
    const noEvm: SignerDeps = { ...deps() };
    delete (noEvm as { evm?: EvmNode }).evm;
    const report = await signApprovedWithdrawals(noEvm);
    expect(report.signed).toEqual([]);
    expect(report.refused.map((r) => r.reason).join('\n')).toMatch(/no Ethereum node/);
    expect((await row(w.id)).status).toBe('approved');
  });
});

describe('Bitcoin', () => {
  const coin = (n: number, amount: bigint): Utxo => ({
    txid: n.toString(16).padStart(64, '0'),
    vout: 0,
    amount,
  });
  let btcDest: string;
  beforeEach(async () => {
    await seedBalance(db, f.orgId, 'btc', 10_000_000n);
    await enablePolicy(db, f, 'btc', {
      min: 1_000n,
      perWithdrawal: 2_000_000n,
      perDay: 4_000_000n,
    });
    btcDest = (await usableDestination(db, f, 'bitcoin', BTC_DEST)).id;
  });

  it('spends hot-wallet coins to the approved address with change back, and never reuses a coin', async () => {
    utxo.coins = [coin(1, 1_500_000n), coin(2, 1_200_000n)];
    const a = await approved({ asset: 'btc', amount: 1_000_000n, destination: btcDest });
    const b = await approved({ asset: 'btc', amount: 1_000_000n, destination: btcDest });
    const c = await approved({ asset: 'btc', amount: 1_000_000n, destination: btcDest });
    const report = await signApprovedWithdrawals(deps());
    expect(report.signed).toEqual([a.id, b.id]);
    expect(report.refused.find((r) => r.id === c.id)?.reason).toMatch(/Insufficient/);

    const ra = await row(a.id);
    const rb = await row(b.id);
    expect(ra.inputs).toEqual([`${'1'.padStart(64, '0')}:0`]);
    expect(rb.inputs).toEqual([`${'2'.padStart(64, '0')}:0`]);
    const parsed = parseUtxoTx(ra.signed_tx!);
    expect(parsed.txid).toBe(ra.txid);
    expect(parsed.outputs[0]?.amount).toBe(1_000_000n);
    expect(parsed.outputs).toHaveLength(2); // payment + change
    expect(BigInt(ra.planned_network_fee!)).toBe(
      1_500_000n - parsed.outputs.reduce((n, o) => n + o.amount, 0n),
    );
    expect(utxo.ensured).toContain(keystore.addresses.bitcoin);
  });

  it('refuses a fee rate above the cap and amounts the fee would swallow', async () => {
    utxo.coins = [coin(1, 5_000_000n)];
    const w = await approved({ asset: 'btc', amount: 1_000_000n, destination: btcDest });
    utxo.rate = 600n;
    await expectRefused(w.id, /fee rate/);
    utxo.rate = 5n;
    const small = await approved({ asset: 'btc', amount: 1_000n, destination: btcDest });
    utxo.rate = 100n; // ~11,000 sat fee on a 1,000 sat payment
    utxo.coins = [coin(1, 5_000_000n), coin(2, 5_000_000n)];
    const report = await signApprovedWithdrawals(deps());
    expect(report.refused.find((r) => r.id === small.id)?.reason).toMatch(/fee is too large/);
  });
});
