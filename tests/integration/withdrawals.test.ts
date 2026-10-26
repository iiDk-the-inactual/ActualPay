/**
 * Withdrawals without a chain: the request/approve/reject/expire lifecycle,
 * deny-by-default policies, destinations, concurrency, database guards, and
 * the broadcast / confirm / settle logic against a controllable fake node.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { beforeEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  validateEvmAddress,
  type BroadcastResult,
  type OutgoingChain,
  type OutgoingStatus,
} from '@actualpay/chains';
import { inTransaction, type Db, type WithdrawalRow } from '@actualpay/database';
import { ensureAccount, verifyLedgerIntegrity, type LedgerAccount } from '@actualpay/ledger';
import { createLogger } from '@actualpay/shared';
import {
  addDestination,
  approveWithdrawal,
  broadcastSigned,
  cancelWithdrawal,
  expireApprovals,
  getEffectivePolicy,
  rejectWithdrawal,
  requestWithdrawal,
  revokeDestination,
  setPolicy,
  setWithdrawalsPaused,
  trackBroadcasts,
  type WithdrawalConfig,
} from '@actualpay/withdrawals';
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

const logger = createLogger({ name: 'test', level: 'silent' });
const CFG: WithdrawalConfig = {
  custodyMode: 'platform',
  feeBps: 100, // 1%
  enabledAssets: ['eth', 'btc', 'usdt-erc20'],
  network: 'testnet',
};
const ETH_ADDRESS = validateEvmAddress('0x' + 'cd'.repeat(20)) as string;
const OTHER_ETH_ADDRESS = validateEvmAddress('0x' + 'ef'.repeat(20)) as string;
const BTC_ADDRESS = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const ETH = 10n ** 18n;

let db: Db;
let f: Fixture;
let destinationId: string;

beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await resetDatabase(db);
  f = await orgWithPeople(db);
  destinationId = (await usableDestination(db, f, 'ethereum', ETH_ADDRESS)).id;
  await seedBalance(db, f.orgId, 'eth', 10n * ETH);
  await enablePolicy(db, f, 'eth', { min: ETH / 1000n, perWithdrawal: 2n * ETH, perDay: 3n * ETH });
});

const requester = () => ({ type: 'user', id: f.requesterId }) as const;
const request = (overrides: Partial<Parameters<typeof requestWithdrawal>[1]> = {}) =>
  requestWithdrawal(
    db,
    {
      organizationId: f.orgId,
      requester: requester(),
      assetId: 'eth',
      amount: ETH,
      destinationId,
      config: CFG,
      ...overrides,
    },
    meta,
  );
const approve = (id: string, approver = f.approverId) =>
  approveWithdrawal(
    db,
    {
      organizationId: f.orgId,
      withdrawalId: id,
      approverUserId: approver,
      sealKey: SEAL_KEY,
      approvalTtlMinutes: 60,
    },
    meta,
  );
const account = (type: LedgerAccount['type'], orgId: string | null = f.orgId, asset = 'eth') =>
  inTransaction(
    db,
    async (tx) =>
      (await ensureAccount(tx, { organizationId: orgId, assetId: asset, type })).balance,
  );
const available = () => account('org_available');
const hold = () => account('org_withdrawal_hold');
const row = (id: string) =>
  db.selectFrom('withdrawals').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

describe('requesting', () => {
  it('holds amount + fee at once and waits for approval', async () => {
    const { withdrawal, created } = await request();
    expect(created).toBe(true);
    expect(withdrawal.status).toBe('pending_approval');
    expect(BigInt(withdrawal.fee_charged)).toBe(ETH / 100n); // 1%
    expect(await available()).toBe(10n * ETH - ETH - ETH / 100n);
    expect(await hold()).toBe(ETH + ETH / 100n);
    expect((await verifyLedgerIntegrity(db)).ok).toBe(true);
  });

  it('is idempotent on clientRef and refuses changed terms', async () => {
    const first = await request({ clientRef: 'payout-1' });
    const again = await request({ clientRef: 'payout-1' });
    expect(again.created).toBe(false);
    expect(again.withdrawal.id).toBe(first.withdrawal.id);
    expect(await hold()).toBe(ETH + ETH / 100n); // held once
    await expect(request({ clientRef: 'payout-1', amount: ETH / 2n })).rejects.toThrow(
      /different terms/,
    );
    const raced = await Promise.all(
      Array.from({ length: 5 }, () => request({ clientRef: 'payout-2', amount: ETH / 10n })),
    );
    expect(new Set(raced.map((r) => r.withdrawal.id)).size).toBe(1);
  });

  it('refuses when the merchant cannot cover amount + fee, leaving no trace', async () => {
    await expect(request({ amount: 2n * ETH, assetId: 'eth' })).resolves.toBeDefined();
    // Drain the rest of the balance with other requests, then one more cannot be held.
    await seedBalance(db, f.orgId, 'btc', 1_000n);
    const before = await available();
    const thin = await usableDestination(db, f, 'bitcoin', BTC_ADDRESS);
    await enablePolicy(db, f, 'btc', { min: 1n, perWithdrawal: 10_000n, perDay: 10_000n });
    await expect(
      request({ assetId: 'btc', amount: 1_000n, destinationId: thin.id }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' }); // 1000 + 1% fee > 1000 held
    expect(await available()).toBe(before);
    expect(
      await db.selectFrom('withdrawals').select('id').where('asset_id', '=', 'btc').execute(),
    ).toHaveLength(0);
  });

  it('is denied by default and respects every limit', async () => {
    // No policy for usdt-erc20: refused.
    await seedBalance(db, f.orgId, 'usdt-erc20', 5_000_000n);
    await expect(
      request({ assetId: 'usdt-erc20', amount: 1_000_000n, destinationId }),
    ).rejects.toThrow(/not enabled for this organization/);
    await expect(request({ amount: 3n * ETH })).rejects.toThrow(/per-withdrawal limit/);
    await expect(request({ amount: ETH / 10_000n })).rejects.toThrow(/below the minimum/);
    // 2 + 1 = 3 ETH is exactly the day's limit; a fourth coin is not.
    await request({ amount: 2n * ETH });
    await request({ amount: ETH });
    await expect(request({ amount: ETH / 10n })).rejects.toThrow(/daily/);
  });

  it('cannot exceed the daily limit however many requests race', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => request({ amount: (3n * ETH) / 4n })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4); // 4 × 0.75 = the 3 ETH limit
    const total = (await db.selectFrom('withdrawals').select('amount').execute()).reduce(
      (n, r) => n + BigInt(r.amount),
      0n,
    );
    expect(total).toBeLessThanOrEqual(3n * ETH);
  });

  it('only pays registered, cooled-down, unrevoked destinations of the right network', async () => {
    const fresh = await addDestination(
      db,
      {
        organizationId: f.orgId,
        userId: f.approverId,
        chain: 'ethereum',
        address: OTHER_ETH_ADDRESS,
        label: 'new',
        network: 'testnet',
        cooldownHours: 24,
      },
      meta,
    );
    await expect(request({ destinationId: fresh.id })).rejects.toThrow(/cool-down/);
    const btc = await usableDestination(db, f, 'bitcoin', BTC_ADDRESS);
    await expect(request({ destinationId: btc.id })).rejects.toThrow(/different network/);
    await revokeDestination(
      db,
      { organizationId: f.orgId, destinationId: destinationId, userId: f.approverId },
      meta,
    );
    await expect(request()).rejects.toThrow(/revoked/);
    // Another organization's destination is simply not found.
    const other = await orgWithPeople(db);
    const theirs = await usableDestination(db, other, 'ethereum', OTHER_ETH_ADDRESS);
    await expect(request({ destinationId: theirs.id })).rejects.toThrow(/not found/i);
  });

  it('refuses in merchant mode, for unsupported assets, and while paused', async () => {
    await expect(request({ config: { ...CFG, custodyMode: 'merchant' } })).rejects.toThrow(
      /CUSTODY_MODE=merchant/,
    );
    await expect(request({ assetId: 'xrp' })).rejects.toThrow(/not supported/);
    await expect(request({ assetId: 'trx' })).rejects.toThrow(/not supported/);
    await setWithdrawalsPaused(db, { paused: true, reason: 'incident', userId: f.adminId }, meta);
    await expect(request()).rejects.toThrow(/paused/);
    await setWithdrawalsPaused(db, { paused: false, userId: f.adminId }, meta);
    await expect(request()).resolves.toBeDefined();
  });
});

describe('approving', () => {
  it('seals the approval and lets a different person approve only', async () => {
    const { withdrawal } = await request();
    await expect(approve(withdrawal.id, f.requesterId)).rejects.toThrow(
      /cannot approve a withdrawal you requested/,
    );
    const approved = await approve(withdrawal.id);
    expect(approved.status).toBe('approved');
    expect(approved.approval_seal).toMatch(/^[0-9a-f]{64}$/);
    expect(approved.approval_expires_at!.getTime() - approved.approved_at!.getTime()).toBe(
      60 * 60_000,
    );
    await expect(approve(withdrawal.id)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
  });

  it('refuses to approve once circumstances changed', async () => {
    const a = await request();
    await revokeDestination(
      db,
      { organizationId: f.orgId, destinationId, userId: f.approverId },
      meta,
    );
    await expect(approve(a.withdrawal.id)).rejects.toThrow(/revoked/);

    // Tightened limits apply to a request that is already waiting.
    const other = await usableDestination(db, f, 'ethereum', OTHER_ETH_ADDRESS, 'second');
    const b = await request({ destinationId: other.id, amount: ETH });
    await setPolicy(
      db,
      {
        organizationId: f.orgId,
        assetId: 'eth',
        userId: f.approverId,
        enabled: true,
        minAmount: ETH / 1000n,
        maxPerWithdrawal: ETH / 2n,
        maxPerDay: ETH / 2n,
        increaseDelayHours: 24,
      },
      meta,
    );
    await expect(approve(b.withdrawal.id)).rejects.toThrow(/per-withdrawal limit/);

    await setWithdrawalsPaused(db, { paused: true, reason: 'x', userId: f.adminId }, meta);
    await expect(approve(b.withdrawal.id)).rejects.toThrow(/paused/);
  });

  it("cannot approve another organization's withdrawal", async () => {
    const { withdrawal } = await request();
    const other = await orgWithPeople(db);
    await expect(
      approveWithdrawal(
        db,
        {
          organizationId: other.orgId,
          withdrawalId: withdrawal.id,
          approverUserId: other.approverId,
          sealKey: SEAL_KEY,
          approvalTtlMinutes: 60,
        },
        meta,
      ),
    ).rejects.toThrow(/not found/i);
  });

  it('requires the seal key', async () => {
    const { withdrawal } = await request();
    await expect(
      approveWithdrawal(
        db,
        {
          organizationId: f.orgId,
          withdrawalId: withdrawal.id,
          approverUserId: f.approverId,
          sealKey: undefined,
          approvalTtlMinutes: 60,
        },
        meta,
      ),
    ).rejects.toThrow(/seal key/);
  });
});

describe('closing before signing', () => {
  it('rejecting, cancelling and expiring all return the held funds exactly once', async () => {
    const start = await available();
    const a = await request();
    const b = await request();
    const c = await request();
    const approved = await approve(c.withdrawal.id);
    expect(await available()).toBe(start - 3n * (ETH + ETH / 100n));

    expect(
      (
        await rejectWithdrawal(
          db,
          {
            organizationId: f.orgId,
            withdrawalId: a.withdrawal.id,
            userId: f.approverId,
            reason: 'no',
          },
          meta,
        )
      ).status,
    ).toBe('rejected');
    expect(
      (
        await cancelWithdrawal(
          db,
          { organizationId: f.orgId, withdrawalId: b.withdrawal.id, userId: f.requesterId },
          meta,
        )
      ).status,
    ).toBe('cancelled');
    // Idempotent.
    await rejectWithdrawal(
      db,
      { organizationId: f.orgId, withdrawalId: a.withdrawal.id, userId: f.approverId },
      meta,
    );
    expect(
      await expireApprovals(db, { now: new Date(approved.approval_expires_at!.getTime() + 1000) }),
    ).toBe(1);
    expect((await row(c.withdrawal.id)).status).toBe('expired');
    expect(await expireApprovals(db, { now: new Date(Date.now() + 86_400_000) })).toBe(0);

    expect(await available()).toBe(start);
    expect(await hold()).toBe(0n);
    expect((await verifyLedgerIntegrity(db)).ok).toBe(true);
    const released = await db
      .selectFrom('ledger_journals')
      .select('id')
      .where('kind', '=', 'withdrawal_release')
      .execute();
    expect(released).toHaveLength(3);
  });

  it('does not expire an approval that is still valid, and cannot cancel once signed', async () => {
    const { withdrawal } = await request();
    const approved = await approve(withdrawal.id);
    expect(
      await expireApprovals(db, { now: new Date(approved.approved_at!.getTime() + 60_000) }),
    ).toBe(0);
    await signByHand(withdrawal.id);
    await expect(
      cancelWithdrawal(
        db,
        { organizationId: f.orgId, withdrawalId: withdrawal.id, userId: f.requesterId },
        meta,
      ),
    ).rejects.toThrow(/already be on its way/);
    await expect(
      rejectWithdrawal(
        db,
        { organizationId: f.orgId, withdrawalId: withdrawal.id, userId: f.approverId },
        meta,
      ),
    ).rejects.toThrow(/already be on its way/);
    expect(await expireApprovals(db, { now: new Date(Date.now() + 86_400_000) })).toBe(0);
  });
});

/** Mark a withdrawal signed with a made-up transaction (the signer has its own tests). */
async function signByHand(
  id: string,
  txid = `0x${randomBytes(32).toString('hex')}`,
): Promise<void> {
  await db
    .updateTable('withdrawals')
    .set({
      status: 'signed',
      hot_address: ETH_ADDRESS,
      signed_at: new Date(),
      signed_tx: '0x02aa',
      txid,
      nonce: 0,
      planned_network_fee: ETH / 1000n,
    })
    .where('id', '=', id)
    .execute();
}

describe('policies', () => {
  it('delays loosening but applies tightening at once, and a later tightening beats an earlier loosening', async () => {
    const t0 = new Date();
    const limits = (max: bigint) => ({
      organizationId: f.orgId,
      assetId: 'eth',
      userId: f.approverId,
      enabled: true,
      minAmount: ETH / 1000n,
      maxPerWithdrawal: max,
      maxPerDay: max * 2n,
      increaseDelayHours: 24,
      now: t0,
    });
    const loosen = await setPolicy(db, limits(5n * ETH), meta);
    expect(loosen.effective_at.getTime() - t0.getTime()).toBe(24 * 3_600_000);
    expect(BigInt((await getEffectivePolicy(db, f.orgId, 'eth', t0))!.max_per_withdrawal)).toBe(
      2n * ETH,
    );

    const tighten = await setPolicy(db, limits(ETH), { ...meta });
    expect(tighten.effective_at.getTime()).toBe(t0.getTime());
    expect(BigInt((await getEffectivePolicy(db, f.orgId, 'eth', t0))!.max_per_withdrawal)).toBe(
      ETH,
    );

    // Once the earlier loosening's delay has passed, the newer tightening still wins.
    const later = new Date(t0.getTime() + 48 * 3_600_000);
    expect(BigInt((await getEffectivePolicy(db, f.orgId, 'eth', later))!.max_per_withdrawal)).toBe(
      ETH,
    );
  });

  it('treats a staged loosening as loosening, and disabling as tightening', async () => {
    const t0 = new Date();
    const base = {
      organizationId: f.orgId,
      assetId: 'eth',
      userId: f.approverId,
      minAmount: ETH / 1000n,
      increaseDelayHours: 24,
      now: t0,
    };
    const small = await setPolicy(
      db,
      { ...base, enabled: true, maxPerWithdrawal: ETH, maxPerDay: ETH },
      meta,
    );
    expect(small.effective_at.getTime()).toBe(t0.getTime()); // lower than the existing 2 ETH
    const step1 = await setPolicy(
      db,
      { ...base, enabled: true, maxPerWithdrawal: 2n * ETH, maxPerDay: 2n * ETH },
      meta,
    );
    expect(step1.effective_at.getTime()).toBeGreaterThan(t0.getTime());
    const off = await setPolicy(
      db,
      { ...base, enabled: false, maxPerWithdrawal: 0n, maxPerDay: 0n, minAmount: 0n },
      meta,
    );
    expect(off.effective_at.getTime()).toBe(t0.getTime());
    await expect(request()).rejects.toThrow(/not enabled/);
  });

  it('rejects inconsistent limits and unsupported assets', async () => {
    const base = { organizationId: f.orgId, userId: f.approverId, increaseDelayHours: 0 };
    await expect(
      setPolicy(
        db,
        {
          ...base,
          assetId: 'eth',
          enabled: true,
          minAmount: 5n,
          maxPerWithdrawal: 4n,
          maxPerDay: 10n,
        },
        meta,
      ),
    ).rejects.toThrow(/minimum/);
    await expect(
      setPolicy(
        db,
        {
          ...base,
          assetId: 'eth',
          enabled: true,
          minAmount: 1n,
          maxPerWithdrawal: 10n,
          maxPerDay: 5n,
        },
        meta,
      ),
    ).rejects.toThrow(/daily/);
    await expect(
      setPolicy(
        db,
        {
          ...base,
          assetId: 'xrp',
          enabled: true,
          minAmount: 1n,
          maxPerWithdrawal: 5n,
          maxPerDay: 5n,
        },
        meta,
      ),
    ).rejects.toThrow(/not supported/);
  });
});

describe('destinations', () => {
  it('validates addresses per network and refuses unsupported chains and duplicates', async () => {
    const add = (chain: 'ethereum' | 'bitcoin' | 'tron' | 'xrpl', address: string) =>
      addDestination(
        db,
        {
          organizationId: f.orgId,
          userId: f.approverId,
          chain,
          address,
          label: 'x',
          network: 'testnet',
          cooldownHours: 0,
        },
        meta,
      );
    await expect(add('ethereum', '0x123')).rejects.toThrow(/valid/);
    await expect(add('bitcoin', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).rejects.toThrow(
      /valid/,
    ); // mainnet on testnet
    await expect(add('tron', 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL')).rejects.toThrow(
      /not supported/,
    );
    await expect(add('ethereum', ETH_ADDRESS)).rejects.toThrow(/already registered/);
  });

  it('sets the cool-down from the time of registration and freezes the address', async () => {
    const now = new Date();
    const dest = await addDestination(
      db,
      {
        organizationId: f.orgId,
        userId: f.approverId,
        chain: 'ethereum',
        address: OTHER_ETH_ADDRESS,
        label: 'x',
        network: 'testnet',
        cooldownHours: 24,
        now,
      },
      meta,
    );
    expect(dest.active_at.getTime() - now.getTime()).toBe(24 * 3_600_000);
    await expect(
      db
        .updateTable('withdrawal_destinations')
        .set({ address: ETH_ADDRESS })
        .where('id', '=', dest.id)
        .execute(),
    ).rejects.toThrow(/immutable/);
    await expect(
      db
        .updateTable('withdrawal_destinations')
        .set({ active_at: now } as never)
        .where('id', '=', dest.id)
        .execute(),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.deleteFrom('withdrawal_destinations').where('id', '=', dest.id).execute(),
    ).rejects.toThrow(/append-only/);
  });
});

describe('database guards', () => {
  it('protects what a withdrawal pays and every step it can take', async () => {
    const { withdrawal } = await request();
    const upd = (set: Record<string, unknown>) =>
      db
        .updateTable('withdrawals')
        .set(set as never)
        .where('id', '=', withdrawal.id)
        .execute();
    await expect(upd({ amount: '1' })).rejects.toThrow(/immutable/);
    await expect(upd({ destination_address: OTHER_ETH_ADDRESS })).rejects.toThrow(/immutable/);
    await expect(upd({ status: 'signed' })).rejects.toThrow(/cannot go from/);
    await expect(upd({ status: 'confirmed' })).rejects.toThrow(/cannot go from/);
    await expect(
      db.deleteFrom('withdrawals').where('id', '=', withdrawal.id).execute(),
    ).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE withdrawals`.execute(db)).rejects.toThrow(
      /append-only|cannot truncate/,
    );

    const approved = await approve(withdrawal.id);
    await expect(upd({ approval_seal: 'a'.repeat(64) })).rejects.toThrow(
      /approval cannot be changed/,
    );
    await expect(upd({ approved_by: f.adminId })).rejects.toThrow(/approval cannot be changed/);
    await expect(upd({ status: 'confirmed' })).rejects.toThrow(
      /cannot go from|confirmed_fields|violates check/,
    );
    expect(approved.status).toBe('approved');

    await signByHand(withdrawal.id);
    await expect(upd({ signed_tx: '0xdeadbeef' })).rejects.toThrow(
      /signed transaction cannot be changed/,
    );
    await expect(upd({ txid: `0x${'11'.repeat(32)}` })).rejects.toThrow(
      /signed transaction cannot be changed/,
    );
    await expect(upd({ status: 'cancelled' })).rejects.toThrow(/cannot go from/);
    await expect(upd({ status: 'approved' })).rejects.toThrow(/cannot go from/);
  });

  it('forbids self-approval even if the service were bypassed', async () => {
    const { withdrawal } = await request();
    await expect(
      db
        .updateTable('withdrawals')
        .set({
          status: 'approved',
          approved_by: f.requesterId,
          approved_at: new Date(),
          approval_expires_at: new Date(Date.now() + 60_000),
          approval_seal: 'a'.repeat(64),
        })
        .where('id', '=', withdrawal.id)
        .execute(),
    ).rejects.toThrow(/withdrawals_no_self_approval/);
  });

  it('keeps policy versions and the hot-wallet registry append-only', async () => {
    const versions = await db.selectFrom('withdrawal_policy_versions').select('id').execute();
    await expect(
      db
        .updateTable('withdrawal_policy_versions')
        .set({ enabled: false })
        .where('id', '=', versions[0]!.id)
        .execute(),
    ).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('withdrawal_policy_versions').execute()).rejects.toThrow(
      /append-only/,
    );
    await expect(db.deleteFrom('platform_settings').execute()).rejects.toThrow(/append-only/);
  });
});

// ------------------------------------------------------------------ chain I/O
class FakeOutgoing implements OutgoingChain {
  readonly chain = 'ethereum' as const;
  readonly network = 'testnet' as const;
  broadcasts: string[] = [];
  broadcastResult: BroadcastResult = { ok: true };
  statuses = new Map<string, OutgoingStatus>();
  broadcast(_raw: string, txid: string): Promise<BroadcastResult> {
    this.broadcasts.push(txid);
    return Promise.resolve(this.broadcastResult);
  }
  status(txid: string): Promise<OutgoingStatus> {
    return Promise.resolve(this.statuses.get(txid) ?? { state: 'unknown' });
  }
}

describe('broadcast, confirmation and settlement', () => {
  let node: FakeOutgoing;
  const nodes = () => new Map<'ethereum', OutgoingChain>([['ethereum', node]]);
  const send = (now?: Date) =>
    broadcastSigned({ db, outgoing: nodes(), logger, ...(now ? { now } : {}) });
  const track = (now?: Date) =>
    trackBroadcasts({ db, outgoing: nodes(), logger, ...(now ? { now } : {}) });
  const mined = (
    over: Partial<Extract<OutgoingStatus, { state: 'mined' }>> = {},
  ): OutgoingStatus => ({
    state: 'mined',
    confirmations: 80n,
    blockHeight: 123n,
    final: true,
    success: true,
    networkFee: ETH / 1000n,
    ...over,
  });

  async function signedWithdrawal(): Promise<WithdrawalRow> {
    const { withdrawal } = await request();
    await approve(withdrawal.id);
    await signByHand(withdrawal.id);
    return row(withdrawal.id);
  }

  beforeEach(() => {
    node = new FakeOutgoing();
  });

  it('broadcasts once, follows to finality and settles the books', async () => {
    await seedPlatformFunds(db, 'eth', ETH / 10n); // the operator funded gas
    const w = await signedWithdrawal();
    expect(await send()).toMatchObject({ broadcast: 1 });
    expect((await row(w.id)).status).toBe('broadcast');
    expect(node.broadcasts).toEqual([w.txid]);
    expect(await send()).toMatchObject({ broadcast: 0 }); // nothing left to send

    node.statuses.set(w.txid!, { state: 'pending' });
    await track();
    expect((await row(w.id)).status).toBe('broadcast');
    node.statuses.set(w.txid!, mined({ final: false, confirmations: 2n }));
    await track();
    expect(await row(w.id)).toMatchObject({ status: 'broadcast', confirmations: '2' });

    const startingCustody = await account('custody', null);
    node.statuses.set(w.txid!, mined());
    expect(await track()).toMatchObject({ confirmed: 1 });
    const done = await row(w.id);
    expect(done.status).toBe('confirmed');
    expect(BigInt(done.final_network_fee!)).toBe(ETH / 1000n);
    // Hold consumed; coins left custody; fee earned and fee paid.
    expect(await hold()).toBe(0n);
    expect(await account('custody', null)).toBe(startingCustody - ETH - ETH / 1000n);
    expect(await account('platform_revenue', null)).toBe(ETH / 10n + ETH / 100n);
    expect(await account('network_fees', null)).toBe(ETH / 1000n);
    expect((await verifyLedgerIntegrity(db)).ok).toBe(true);
    await track();
    expect(await account('network_fees', null)).toBe(ETH / 1000n); // settled once
  });

  it('returns the funds and books the burnt fee when the transaction reverts', async () => {
    await seedPlatformFunds(db, 'eth', ETH / 10n);
    const w = await signedWithdrawal();
    const before = await available();
    await send();
    node.statuses.set(w.txid!, mined({ success: false }));
    expect(await track()).toMatchObject({ failed: 1 });
    expect((await row(w.id)).status).toBe('failed');
    expect(await available()).toBe(before + ETH + ETH / 100n); // everything came back
    expect(await hold()).toBe(0n);
    expect(await account('network_fees', null)).toBe(ETH / 1000n);
    expect((await verifyLedgerIntegrity(db)).ok).toBe(true);
  });

  it('never releases a hold on mere uncertainty: it asks a human', async () => {
    const w = await signedWithdrawal();
    node.broadcastResult = { ok: false, permanent: true, error: 'insufficient funds' };
    expect(await send()).toMatchObject({ needsReview: 1 });
    expect((await row(w.id)).status).toBe('needs_review');
    expect(await hold()).toBe(ETH + ETH / 100n); // still held
    const issues = await db
      .selectFrom('reconciliation_issues')
      .select(['kind', 'severity'])
      .where('status', '=', 'open')
      .execute();
    expect(issues).toContainEqual({ kind: 'withdrawal_rejected_by_node', severity: 'critical' });
  });

  it('retries a transient broadcast failure and keeps the signed transaction untouched', async () => {
    const w = await signedWithdrawal();
    node.broadcastResult = { ok: false, permanent: false, error: 'node unavailable' };
    expect(await send()).toMatchObject({ broadcast: 0, needsReview: 0 });
    let r = await row(w.id);
    expect(r).toMatchObject({
      status: 'signed',
      broadcast_attempts: 1,
      last_error: 'node unavailable',
    });
    node.broadcastResult = { ok: true };
    expect(await send()).toMatchObject({ broadcast: 1 });
    r = await row(w.id);
    expect(r.status).toBe('broadcast');
    expect(r.signed_tx).toBe(w.signed_tx);
    expect(r.txid).toBe(w.txid);
  });

  it('flags a transaction that vanished, but only after a grace period and a failed re-broadcast', async () => {
    const w = await signedWithdrawal();
    await send();
    node.statuses.set(w.txid!, { state: 'unknown' });
    const t0 = new Date();
    await track(t0);
    expect((await row(w.id)).status).toBe('broadcast'); // still within the grace period

    const later = new Date(t0.getTime() + 31 * 60_000);
    await track(later); // re-broadcast succeeds (the node accepts it again): not lost
    expect((await row(w.id)).status).toBe('broadcast');
    node.broadcastResult = { ok: false, permanent: true, error: 'nonce too low' };
    expect(await track(later)).toMatchObject({ needsReview: 1 });
    expect((await row(w.id)).status).toBe('needs_review');
    expect(await hold()).toBe(ETH + ETH / 100n);
  });

  it('sends a conflicted transaction to review immediately', async () => {
    const w = await signedWithdrawal();
    await send();
    node.statuses.set(w.txid!, { state: 'conflicted' });
    expect(await track()).toMatchObject({ needsReview: 1 });
    expect((await row(w.id)).status).toBe('needs_review');
  });

  it('raises an issue (and keeps the hold) when custody cannot absorb the network fee', async () => {
    // Bitcoin with custody exactly equal to what the merchant holds: nothing is left to pay the fee from.
    const second = await orgWithPeople(db);
    await seedBalance(db, second.orgId, 'btc', 10_000n);
    await enablePolicy(db, second, 'btc', { min: 1n, perWithdrawal: 10_000n, perDay: 10_000n });
    const dest = await usableDestination(db, second, 'bitcoin', BTC_ADDRESS);
    const { withdrawal } = await requestWithdrawal(
      db,
      {
        organizationId: second.orgId,
        requester: { type: 'user', id: second.requesterId },
        assetId: 'btc',
        amount: 9_900n,
        destinationId: dest.id,
        config: CFG,
      },
      meta,
    );
    await approveWithdrawal(
      db,
      {
        organizationId: second.orgId,
        withdrawalId: withdrawal.id,
        approverUserId: second.approverId,
        sealKey: SEAL_KEY,
        approvalTtlMinutes: 60,
      },
      meta,
    );
    const txid = 'ab'.repeat(32);
    await db
      .updateTable('withdrawals')
      .set({
        status: 'signed',
        hot_address: BTC_ADDRESS,
        signed_at: new Date(),
        signed_tx: '02aa',
        txid,
        inputs: [`${'cd'.repeat(32)}:0`],
        planned_network_fee: 150n,
      })
      .where('id', '=', withdrawal.id)
      .execute();
    const both = new Map<'ethereum' | 'bitcoin', OutgoingChain>([
      ['ethereum', node],
      ['bitcoin', node],
    ]);
    await broadcastSigned({ db, outgoing: both, logger });
    node.statuses.set(txid, mined({ networkFee: 150n }));
    expect(await trackBroadcasts({ db, outgoing: both, logger })).toMatchObject({ confirmed: 0 });
    expect((await row(withdrawal.id)).status).toBe('broadcast');
    const issues = await db
      .selectFrom('reconciliation_issues')
      .select('kind')
      .where('status', '=', 'open')
      .execute();
    expect(issues.map((i) => i.kind)).toContain('withdrawal_settlement_blocked');
    // The operator funds custody; the next pass settles and the issue clears itself.
    await seedPlatformFunds(db, 'btc', 1_000n);
    expect(await trackBroadcasts({ db, outgoing: both, logger })).toMatchObject({ confirmed: 1 });
    const after = await db
      .selectFrom('reconciliation_issues')
      .select('kind')
      .where('status', '=', 'open')
      .execute();
    expect(after.map((i) => i.kind)).not.toContain('withdrawal_settlement_blocked');
  });
});
