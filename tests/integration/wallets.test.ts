/**
 * Wallets and deposit addresses: confirmation gate, uniqueness across
 * organizations, concurrent allocation, database guards, and API access control.
 */
import type { LightMyRequestResponse } from 'fastify';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveEvmAddress, deriveUtxoAddress, parseExtendedPublicKey } from '@actualpay/chains';
import {
  allocateDepositAddress,
  confirmWallet,
  createWallet,
  deriveDeposit,
  type CreateWalletParams,
} from '@actualpay/wallets';
import {
  Agent,
  createOrg,
  createTestApi,
  signedInUser,
  totpCode,
  type TestApi,
} from './api-helpers';
import { resetDatabase } from './helpers';

const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587cf };
const VPUB_VERSIONS = { private: 0x045f18bc, public: 0x045f1cf6 };
const MNEMONIC_A =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MNEMONIC_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

function accountKey(
  mnemonic: string,
  path: string,
  versions?: { private: number; public: number },
): string {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic), versions);
  return root.derive(path).publicExtendedKey;
}

const btcA = accountKey(MNEMONIC_A, "m/84'/1'/0'", TESTNET_VERSIONS);
const btcAasVpub = accountKey(MNEMONIC_A, "m/84'/1'/0'", VPUB_VERSIONS);
const btcB = accountKey(MNEMONIC_B, "m/84'/1'/0'", TESTNET_VERSIONS);
const ethA = accountKey(MNEMONIC_A, "m/44'/60'/0'");
const ethB = accountKey(MNEMONIC_B, "m/44'/60'/0'");
const trxA = accountKey(MNEMONIC_A, "m/44'/195'/0'");
const btcMainnet = accountKey(MNEMONIC_A, "m/84'/0'/0'");

const XRPL_ADDRESS = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'; // a well-formed classic address
const ENV = {
  ENABLED_ASSETS: 'btc,eth,trx,xrp',
  BITCOIN_RPC_URL: 'http://127.0.0.1:1',
  BITCOIN_RPC_USERNAME: 'u',
  BITCOIN_RPC_PASSWORD: 'p',
  ETHEREUM_RPC_URL: 'http://127.0.0.1:1',
  TRON_API_URL: 'http://127.0.0.1:1',
};
const ENABLED = ['bitcoin', 'ethereum', 'tron', 'xrpl'] as const;

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi(ENV);
  await resetDatabase(api.db);
});
afterAll(async () => {
  await api.close();
  await api.db.destroy();
});

const meta = { requestId: 'test' };
let orgSeq = 0;

async function newOrgWithUser(): Promise<{ orgId: string; userId: string }> {
  orgSeq += 1;
  const user = await signedInUser(api, `wallet${orgSeq}`);
  const orgId = await createOrg(user, `Wallet Org ${orgSeq}`);
  return { orgId, userId: user.userId! };
}

function walletParams(
  orgId: string,
  userId: string,
  overrides: Partial<CreateWalletParams> = {},
): CreateWalletParams {
  const chain = overrides.chain ?? 'bitcoin';
  return {
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    chain,
    network: 'testnet',
    enabledChains: ENABLED,
    label: 'Main',
    ...(chain === 'xrpl' ? {} : { accountXpub: btcA }),
    ...overrides,
  };
}

async function confirmedWallet(
  orgId: string,
  userId: string,
  overrides: Partial<CreateWalletParams> = {},
) {
  const { wallet, firstAddress } = await createWallet(
    api.db,
    walletParams(orgId, userId, overrides),
    meta,
  );
  await confirmWallet(
    api.db,
    {
      organizationId: orgId,
      walletId: wallet.id,
      actor: { type: 'user', id: userId },
      address: firstAddress.address,
    },
    meta,
  );
  return wallet;
}

describe('creating wallets', () => {
  it('derives the first address from the public key and issues nothing yet', async () => {
    const { orgId, userId } = await newOrgWithUser();
    const { wallet, firstAddress } = await createWallet(api.db, walletParams(orgId, userId), meta);
    expect(firstAddress.address).toBe(
      deriveUtxoAddress('bitcoin', 'testnet', parseExtendedPublicKey(btcA), 0),
    );
    expect(firstAddress.address.startsWith('tb1q')).toBe(true);
    expect(wallet.verified_at).toBeNull();
    const issued = await api.db.selectFrom('deposit_addresses').select('id').execute();
    expect(issued.filter((r) => r.id).length).toBe(0);
  });

  it('refuses private keys without echoing them', async () => {
    const { orgId, userId } = await newOrgWithUser();
    const xprv = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC_A), TESTNET_VERSIONS).derive(
      "m/84'/1'/0'",
    ).privateExtendedKey;
    const error = await createWallet(
      api.db,
      walletParams(orgId, userId, { accountXpub: xprv }),
      meta,
    ).catch((e: unknown) => e);
    if (!(error instanceof Error)) throw new Error('expected createWallet to reject');
    expect(error.message).toMatch(/PRIVATE key/);
    expect(error.message).not.toContain(xprv);
  });

  it('refuses a key for the wrong network, an unenabled chain and a non-account key', async () => {
    const { orgId, userId } = await newOrgWithUser();
    await expect(
      createWallet(api.db, walletParams(orgId, userId, { accountXpub: btcMainnet }), meta),
    ).rejects.toThrow(/mainnet key but the deployment runs on testnet/);
    await expect(
      createWallet(api.db, walletParams(orgId, userId, { enabledChains: ['xrpl'] }), meta),
    ).rejects.toThrow(/No bitcoin asset is enabled/);
    const master = HDKey.fromMasterSeed(
      mnemonicToSeedSync(MNEMONIC_A),
      TESTNET_VERSIONS,
    ).publicExtendedKey;
    await expect(
      createWallet(api.db, walletParams(orgId, userId, { accountXpub: master }), meta),
    ).rejects.toThrow(/account-level/);
  });

  it('never lets two wallets, in any organization, share a key, even re-encoded', async () => {
    const first = await newOrgWithUser();
    const second = await newOrgWithUser();
    await createWallet(
      api.db,
      walletParams(first.orgId, first.userId, { accountXpub: btcB }),
      meta,
    );
    await expect(
      createWallet(api.db, walletParams(second.orgId, second.userId, { accountXpub: btcB }), meta),
    ).rejects.toThrow(/already registered/);
    // The same key serialized with different version bytes is still the same key.
    const sameKeyOtherEncoding = accountKey(MNEMONIC_B, "m/84'/1'/0'", VPUB_VERSIONS);
    expect(sameKeyOtherEncoding).not.toBe(btcB);
    await expect(
      createWallet(
        api.db,
        walletParams(second.orgId, second.userId, { accountXpub: sameKeyOtherEncoding }),
        meta,
      ),
    ).rejects.toThrow(/already registered/);
    expect(btcAasVpub).not.toBe(btcA);
  });
});

describe('confirmation gate', () => {
  it('issues nothing until the first address is confirmed, and rejects a wrong address', async () => {
    const { orgId, userId } = await newOrgWithUser();
    const { wallet } = await createWallet(
      api.db,
      walletParams(orgId, userId, { chain: 'ethereum', accountXpub: ethA }),
      meta,
    );
    await expect(
      allocateDepositAddress(api.db, { organizationId: orgId, walletId: wallet.id }),
    ).rejects.toThrow(/Confirm the wallet/);

    const wrong = deriveEvmAddress(parseExtendedPublicKey(ethA), 1);
    await expect(
      confirmWallet(
        api.db,
        {
          organizationId: orgId,
          walletId: wallet.id,
          actor: { type: 'user', id: userId },
          address: wrong,
        },
        meta,
      ),
    ).rejects.toThrow(/does not match/);
    const audit = await api.db
      .selectFrom('audit_log')
      .select('action')
      .where('target_id', '=', wallet.id)
      .execute();
    expect(audit.map((a) => a.action)).toContain('wallet.confirmation_failed');

    // EIP-55 case does not matter when confirming.
    const lower = deriveEvmAddress(parseExtendedPublicKey(ethA), 0).toLowerCase();
    const confirmed = await confirmWallet(
      api.db,
      {
        organizationId: orgId,
        walletId: wallet.id,
        actor: { type: 'user', id: userId },
        address: lower,
      },
      meta,
    );
    expect(confirmed.verified_at).not.toBeNull();
    const row = await allocateDepositAddress(api.db, {
      organizationId: orgId,
      walletId: wallet.id,
    });
    expect(row.derivation_index).toBe('0');
  });

  it("cannot confirm or use another organization's wallet", async () => {
    const owner = await newOrgWithUser();
    const other = await newOrgWithUser();
    const { wallet, firstAddress } = await createWallet(
      api.db,
      walletParams(owner.orgId, owner.userId, { accountXpub: ethB, chain: 'ethereum' }),
      meta,
    );
    await expect(
      confirmWallet(
        api.db,
        {
          organizationId: other.orgId,
          walletId: wallet.id,
          actor: { type: 'user', id: other.userId },
          address: firstAddress.address,
        },
        meta,
      ),
    ).rejects.toThrow(/not found/i);
  });
});

describe('address allocation', () => {
  it('hands out distinct, sequential addresses under heavy concurrency', async () => {
    const { orgId, userId } = await newOrgWithUser();
    const wallet = await confirmedWallet(orgId, userId, { chain: 'tron', accountXpub: trxA });
    const rows = await Promise.all(
      Array.from({ length: 25 }, () =>
        allocateDepositAddress(api.db, { organizationId: orgId, walletId: wallet.id }),
      ),
    );
    expect(new Set(rows.map((r) => r.address)).size).toBe(25);
    expect(rows.map((r) => Number(r.derivation_index)).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, i) => i),
    );
    const after = await api.db
      .selectFrom('wallets')
      .select('next_index')
      .where('id', '=', wallet.id)
      .executeTakeFirstOrThrow();
    expect(after.next_index).toBe('25');
    for (const row of rows) {
      expect(row.address).toBe(
        deriveDeposit({ ...wallet, ...{} }, Number(row.derivation_index)).address,
      );
      expect(row.address.startsWith('T')).toBe(true);
    }
  });

  it('rolls the address back with the caller transaction', async () => {
    const { orgId, userId } = await newOrgWithUser();
    const wallet = await confirmedWallet(orgId, userId, {
      chain: 'ethereum',
      accountXpub: accountKey(MNEMONIC_B, "m/44'/60'/1'"),
    });
    await expect(
      api.db.transaction().execute(async (tx) => {
        await allocateDepositAddress(tx, { organizationId: orgId, walletId: wallet.id });
        throw new Error('invoice creation failed');
      }),
    ).rejects.toThrow(/invoice creation failed/);
    const next = await allocateDepositAddress(api.db, {
      organizationId: orgId,
      walletId: wallet.id,
    });
    expect(next.derivation_index).toBe('0'); // index 0 was not burned
  });

  it('uses destination tags for XRPL, starting at 1, on one shared address', async () => {
    const { orgId, userId } = await newOrgWithUser();
    const wallet = await confirmedWallet(orgId, userId, {
      chain: 'xrpl',
      xrplAddress: XRPL_ADDRESS,
    });
    const a = await allocateDepositAddress(api.db, { organizationId: orgId, walletId: wallet.id });
    const b = await allocateDepositAddress(api.db, { organizationId: orgId, walletId: wallet.id });
    expect([a.destination_tag, b.destination_tag]).toEqual(['1', '2']);
    expect(a.address).toBe(XRPL_ADDRESS);
    expect(a.derivation_index).toBeNull();
    // Another organization cannot register the same XRPL account.
    const other = await newOrgWithUser();
    await expect(
      createWallet(
        api.db,
        walletParams(other.orgId, other.userId, {
          chain: 'xrpl',
          xrplAddress: XRPL_ADDRESS,
        }),
        meta,
      ),
    ).rejects.toThrow(/already registered/);
  });

  it('stops issuing from an archived wallet', async () => {
    const { orgId, userId } = await newOrgWithUser();
    const wallet = await confirmedWallet(orgId, userId, {
      chain: 'ethereum',
      accountXpub: accountKey(MNEMONIC_A, "m/44'/60'/7'"),
    });
    const { archiveWallet } = await import('@actualpay/wallets');
    await archiveWallet(
      api.db,
      { organizationId: orgId, walletId: wallet.id, actor: { type: 'user', id: userId } },
      meta,
    );
    await expect(
      allocateDepositAddress(api.db, { organizationId: orgId, walletId: wallet.id }),
    ).rejects.toThrow(/archived/);
  });
});

describe('database guards', () => {
  it('protects key material, the counter, verification and issued addresses', async () => {
    const { orgId, userId } = await newOrgWithUser();
    const wallet = await confirmedWallet(orgId, userId, {
      chain: 'ethereum',
      accountXpub: accountKey(MNEMONIC_B, "m/44'/60'/9'"),
    });
    const row = await allocateDepositAddress(api.db, {
      organizationId: orgId,
      walletId: wallet.id,
    });

    const update = (set: Record<string, unknown>) =>
      api.db.updateTable('wallets').set(set).where('id', '=', wallet.id).execute();
    await expect(update({ account_xpub: ethB })).rejects.toThrow(/immutable/);
    await expect(update({ chain: 'tron' })).rejects.toThrow(/immutable/);
    await expect(update({ organization_id: (await newOrgWithUser()).orgId })).rejects.toThrow(
      /immutable/,
    );
    await expect(update({ next_index: 0 })).rejects.toThrow(/backwards/);
    await expect(update({ verified_at: null, verified_by: null })).rejects.toThrow(
      /verification cannot be changed/,
    );
    await expect(
      api.db.deleteFrom('wallets').where('id', '=', wallet.id).execute(),
    ).rejects.toThrow(/append-only/);

    await expect(
      api.db
        .updateTable('deposit_addresses')
        .set({ address: row.address.toLowerCase() })
        .where('id', '=', row.id)
        .execute(),
    ).rejects.toThrow(/append-only/);
    await expect(
      api.db.deleteFrom('deposit_addresses').where('id', '=', row.id).execute(),
    ).rejects.toThrow(/append-only/);

    // The same address cannot be inserted twice, even under a different wallet record.
    await expect(
      api.db
        .insertInto('deposit_addresses')
        .values({
          wallet_id: wallet.id,
          organization_id: orgId,
          chain: 'ethereum',
          network: 'testnet',
          address: row.address,
          derivation_index: 5,
          destination_tag: null,
        })
        .execute(),
    ).rejects.toThrow(/duplicate key/);
    // And a deposit row cannot claim another organization's wallet.
    await expect(
      api.db
        .insertInto('deposit_addresses')
        .values({
          wallet_id: wallet.id,
          organization_id: (await newOrgWithUser()).orgId,
          chain: 'ethereum',
          network: 'testnet',
          address: '0x' + 'ab'.repeat(20),
          derivation_index: 6,
          destination_tag: null,
        })
        .execute(),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('HTTP API', () => {
  const code = (r: LightMyRequestResponse) => r.json<{ error: { code: string } }>().error.code;

  async function owner(label: string): Promise<{ agent: Agent; orgId: string }> {
    const agent = await signedInUser(api, label);
    const orgId = await createOrg(agent, `${label} org`);
    return { agent, orgId };
  }

  async function enableMfa(agent: Agent): Promise<void> {
    const setup = await agent.request('POST', '/v1/me/mfa/totp/setup');
    const { secret } = setup.json<{ secret: string }>();
    const confirm = await agent.request('POST', '/v1/me/mfa/totp/confirm', {
      body: { code: totpCode(secret) },
    });
    expect(confirm.statusCode).toBe(200);
  }

  it('requires two-factor authentication to register a wallet', async () => {
    const { agent, orgId } = await owner('nomfa');
    const response = await agent.request('POST', `/v1/organizations/${orgId}/wallets`, {
      body: { chain: 'ethereum', label: 'Hot', accountXpub: ethA },
    });
    expect(response.statusCode).toBe(403);
    expect(code(response)).toBe('MFA_REQUIRED');
  });

  it('registers, confirms and lists a wallet; keys can read but never manage', async () => {
    const { agent, orgId } = await owner('flow');
    await enableMfa(agent);
    const key = accountKey(MNEMONIC_A, "m/44'/60'/3'");

    const created = await agent.request('POST', `/v1/organizations/${orgId}/wallets`, {
      body: { chain: 'ethereum', label: 'Hot', accountXpub: key },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<{
      wallet: { id: string; confirmed: boolean; nextIndex: string };
      firstAddress: { address: string; destinationTag: number | null };
    }>();
    expect(body.wallet.confirmed).toBe(false);
    expect(body.firstAddress.address).toBe(deriveEvmAddress(parseExtendedPublicKey(key), 0));
    const walletUrl = `/v1/organizations/${orgId}/wallets/${body.wallet.id}`;

    expect(
      (
        await agent.request('POST', `${walletUrl}/confirm`, {
          body: { address: deriveEvmAddress(parseExtendedPublicKey(key), 4) },
        })
      ).statusCode,
    ).toBe(400);
    const confirmed = await agent.request('POST', `${walletUrl}/confirm`, {
      body: { address: body.firstAddress.address },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json<{ confirmed: boolean }>().confirmed).toBe(true);

    await allocateDepositAddress(api.db, { organizationId: orgId, walletId: body.wallet.id });
    const addresses = await agent.request('GET', `${walletUrl}/addresses?limit=1`);
    expect(addresses.statusCode).toBe(200);
    expect(addresses.json<{ data: unknown[] }>().data).toHaveLength(1);

    // An API key with wallet:read can list but cannot register wallets.
    const created2 = await agent.request('POST', `/v1/organizations/${orgId}/api-keys`, {
      body: { name: 'reader', scopes: ['wallet:read'] },
    });
    const { key: apiKey } = created2.json<{ key: string }>();
    const auth = { authorization: `Bearer ${apiKey}` };
    const list = await api.app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/wallets`,
      headers: auth,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ data: unknown[] }>().data).toHaveLength(1);
    const attempt = await api.app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/wallets`,
      headers: auth,
      payload: { chain: 'ethereum', label: 'Evil', accountXpub: ethB },
    });
    expect([401, 403]).toContain(attempt.statusCode);
    expect(
      (await agent.request('GET', `/v1/organizations/${orgId}/wallets`)).json<{ data: unknown[] }>()
        .data,
    ).toHaveLength(1);
  });

  it('hides wallets from other organizations', async () => {
    const alice = await owner('alice-w');
    await enableMfa(alice.agent);
    const created = await alice.agent.request('POST', `/v1/organizations/${alice.orgId}/wallets`, {
      body: { chain: 'tron', label: 'T', accountXpub: accountKey(MNEMONIC_B, "m/44'/195'/4'") },
    });
    expect(created.statusCode).toBe(201);
    const walletId = created.json<{ wallet: { id: string } }>().wallet.id;

    const mallory = await owner('mallory-w');
    for (const url of [
      `/v1/organizations/${alice.orgId}/wallets`,
      `/v1/organizations/${alice.orgId}/wallets/${walletId}`,
      `/v1/organizations/${alice.orgId}/wallets/${walletId}/addresses`,
    ]) {
      expect((await mallory.agent.request('GET', url)).statusCode, url).toBe(404);
    }
    // Using one's own organization id with someone else's wallet id also finds nothing.
    expect(
      (await mallory.agent.request('GET', `/v1/organizations/${mallory.orgId}/wallets/${walletId}`))
        .statusCode,
    ).toBe(404);
  });
});
