/** Withdrawal and platform-admin HTTP endpoints: who may do what, and what is refused. */
import { randomBytes } from 'node:crypto';
import { HDKey } from '@scure/bip32';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Agent,
  createOrg,
  createTestApi,
  signedInUser,
  withMfa,
  type TestApi,
} from './api-helpers';
import { resetDatabase } from './helpers';
import { seedBalance } from './withdrawal-helpers';

const ETH = 10n ** 18n;
const DEST = '0x' + 'cd'.repeat(20);
const HOT = '0x' + 'ab'.repeat(20);
let platform: TestApi;
let merchantApi: TestApi;

const platformEnv = {
  ENABLED_ASSETS: 'eth,xrp',
  ETHEREUM_RPC_URL: 'http://127.0.0.1:1',
  CUSTODY_MODE: 'platform',
  WITHDRAWAL_SEAL_KEY: randomBytes(32).toString('base64'),
  WITHDRAWAL_DESTINATION_COOLDOWN_HOURS: '0',
  WITHDRAWAL_POLICY_INCREASE_DELAY_HOURS: '0',
};

beforeAll(async () => {
  platform = await createTestApi(platformEnv);
  merchantApi = await createTestApi(
    { ENABLED_ASSETS: 'eth,xrp', ETHEREUM_RPC_URL: 'http://127.0.0.1:1' },
    platform.db,
  );
  await resetDatabase(platform.db);
});
afterAll(async () => {
  await merchantApi.close();
  await platform.close();
  await platform.db.destroy();
});

async function makeAdmin(api: TestApi, label: string): Promise<Agent> {
  const user = await signedInUser(api, label);
  await api.db
    .updateTable('users')
    .set({ is_platform_admin: true })
    .where('id', '=', user.userId!)
    .execute();
  return withMfa(api, user);
}

async function join(
  api: TestApi,
  orgId: string,
  label: string,
  role: 'finance' | 'owner',
  mfa: boolean,
): Promise<Agent> {
  const user = await signedInUser(api, label);
  await api.db
    .insertInto('organization_members')
    .values({ organization_id: orgId, user_id: user.userId!, role })
    .execute();
  return mfa ? withMfa(api, user) : user;
}

async function team() {
  const owner = await signedInUser(platform, 'owner');
  const orgId = await createOrg(owner, 'Shop');
  const ownerMfa = await withMfa(platform, owner);
  const requester = await join(platform, orgId, 'req', 'finance', false);
  await seedBalance(platform.db, orgId, 'eth', 10n * ETH);
  const base = `/v1/organizations/${orgId}`;
  expect(
    (
      await ownerMfa.request('PUT', `${base}/withdrawal-policies/eth`, {
        body: { enabled: true, minAmount: '0.01', maxPerWithdrawal: '5', maxPerDay: '8' },
      })
    ).statusCode,
  ).toBe(200);
  const dest = await ownerMfa.request('POST', `${base}/withdrawal-destinations`, {
    body: { chain: 'ethereum', address: DEST, label: 'cold' },
  });
  expect(dest.statusCode).toBe(201);
  return { owner: ownerMfa, requester, orgId, base, destinationId: dest.json<{ id: string }>().id };
}

describe('withdrawals over HTTP', () => {
  it('walks request → approve with two different people, and refuses self-approval', async () => {
    const t = await team();
    const created = await t.requester.request('POST', `${t.base}/withdrawals`, {
      body: { asset: 'eth', amount: '1', destinationId: t.destinationId },
    });
    expect(created.statusCode).toBe(201);
    const w = created.json<{ id: string; status: string }>();
    expect(w.status).toBe('pending_approval');

    // The owner can request AND approve their own? No: approver must differ from requester.
    const ownRequest = await t.owner.request('POST', `${t.base}/withdrawals`, {
      body: { asset: 'eth', amount: '1', destinationId: t.destinationId },
    });
    expect(ownRequest.statusCode).toBe(201);
    const own = await t.owner.request(
      'POST',
      `${t.base}/withdrawals/${ownRequest.json<{ id: string }>().id}/approve`,
    );
    expect(own.statusCode).toBeGreaterThanOrEqual(400);
    expect(own.statusCode).toBeLessThan(500);

    const approved = await t.owner.request('POST', `${t.base}/withdrawals/${w.id}/approve`);
    expect(approved.statusCode).toBe(200);
    expect(approved.json<{ status: string }>().status).toBe('approved');
  });

  it('requires two-factor authentication to approve and a finance role is not enough', async () => {
    const t = await team();
    const created = await t.requester.request('POST', `${t.base}/withdrawals`, {
      body: { asset: 'eth', amount: '1', destinationId: t.destinationId },
    });
    const id = created.json<{ id: string }>().id;
    const noMfaApprover = await join(platform, t.orgId, 'nomfa', 'owner', false);
    const refused = await noMfaApprover.request('POST', `${t.base}/withdrawals/${id}/approve`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('MFA_REQUIRED');
    const byRequester = await t.requester.request('POST', `${t.base}/withdrawals/${id}/approve`);
    expect(byRequester.statusCode).toBe(403);
  });

  it("does not show one organization's withdrawals to another", async () => {
    const a = await team();
    const b = await team();
    const created = await a.requester.request('POST', `${a.base}/withdrawals`, {
      body: { asset: 'eth', amount: '1', destinationId: a.destinationId },
    });
    const id = created.json<{ id: string }>().id;
    expect((await b.owner.request('GET', `${a.base}/withdrawals/${id}`)).statusCode).toBe(404);
    expect((await b.owner.request('GET', `${b.base}/withdrawals/${id}`)).statusCode).toBe(404);
    // Using another organization's destination fails too.
    const cross = await b.requester.request('POST', `${b.base}/withdrawals`, {
      body: { asset: 'eth', amount: '1', destinationId: a.destinationId },
    });
    expect(cross.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('refuses amounts beyond the policy and requires an enabled policy', async () => {
    const t = await team();
    const big = await t.requester.request('POST', `${t.base}/withdrawals`, {
      body: { asset: 'eth', amount: '6', destinationId: t.destinationId },
    });
    expect(big.statusCode).toBe(400);
    const unlisted = await t.requester.request('POST', `${t.base}/withdrawals`, {
      body: { asset: 'xrp', amount: '1', destinationId: t.destinationId },
    });
    expect(unlisted.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('refuses everything in merchant custody mode', async () => {
    const owner = await signedInUser(merchantApi, 'mowner');
    const orgId = await createOrg(owner, 'Merchant');
    const ownerMfa = await withMfa(merchantApi, owner);
    const response = await ownerMfa.request(
      'POST',
      `/v1/organizations/${orgId}/withdrawal-destinations`,
      { body: { chain: 'ethereum', address: DEST, label: 'cold' } },
    );
    expect(response.statusCode).toBe(409);
  });
});

describe('platform administration', () => {
  it('is closed to ordinary users and to admins without two-factor authentication', async () => {
    const user = await signedInUser(platform, 'plain');
    expect((await user.request('GET', '/v1/admin/status')).statusCode).toBe(403);
    const ordinary = await withMfa(platform, user);
    expect((await ordinary.request('GET', '/v1/admin/status')).statusCode).toBe(403);
    expect((await new Agent(platform).request('GET', '/v1/admin/status')).statusCode).toBe(401);

    const adminNoMfa = await signedInUser(platform, 'adminnomfa');
    await platform.db
      .updateTable('users')
      .set({ is_platform_admin: true })
      .where('id', '=', adminNoMfa.userId!)
      .execute();
    const relog = new Agent(platform);
    await relog.login(adminNoMfa.email);
    const response = await relog.request('POST', '/v1/admin/withdrawals/pause', {
      body: { reason: 'drill' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('MFA_REQUIRED');
  });

  it('registers hot wallets, pauses and resumes withdrawals, and reports status', async () => {
    const admin = await makeAdmin(platform, 'admin');
    const hot = await admin.request('POST', '/v1/admin/hot-wallets', {
      body: { chain: 'ethereum', address: HOT, label: 'hot' },
    });
    expect(hot.statusCode).toBe(201);
    const second = await admin.request('POST', '/v1/admin/hot-wallets', {
      body: { chain: 'ethereum', address: '0x' + 'ee'.repeat(20), label: 'second' },
    });
    expect(second.statusCode).toBe(409); // one active hot wallet per chain
    const t = await team();

    expect(
      (await admin.request('POST', '/v1/admin/withdrawals/pause', { body: { reason: 'drill' } }))
        .statusCode,
    ).toBe(200);
    const status = await admin.request('GET', '/v1/admin/status');
    expect(status.json<{ withdrawalsPaused: boolean }>().withdrawalsPaused).toBe(true);

    // While paused no one can request a withdrawal.
    const refused = await t.requester.request('POST', `${t.base}/withdrawals`, {
      body: { asset: 'eth', amount: '1', destinationId: t.destinationId },
    });
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect((await admin.request('POST', '/v1/admin/withdrawals/resume')).statusCode).toBe(200);
    expect(
      (await admin.request('GET', '/v1/admin/status')).json<{ withdrawalsPaused: boolean }>()
        .withdrawalsPaused,
    ).toBe(false);
  });

  it('blocks organizations from registering their own wallets in platform mode', async () => {
    const plain = await signedInUser(platform, 'wowner');
    const orgId = await createOrg(plain, 'Shop2');
    const owner = await withMfa(platform, plain);
    const response = await owner.request('POST', `/v1/organizations/${orgId}/wallets`, {
      body: {
        chain: 'ethereum',
        label: 'mine',
        accountXpub: HDKey.fromMasterSeed(randomBytes(32)).derive("m/44'/60'/0'").publicExtendedKey,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).toMatch(/platform custody mode/);
  });
});
