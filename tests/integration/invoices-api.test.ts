/** Invoice, payment and payment-link HTTP endpoints, including the public ones. */
import type { LightMyRequestResponse } from 'fastify';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordObservation } from '@actualpay/payments';
import { confirmWallet, createWallet } from '@actualpay/wallets';
import { Agent, createOrg, createTestApi, signedInUser, type TestApi } from './api-helpers';
import { resetDatabase } from './helpers';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
let api: TestApi;
let keySeq = 100;
const meta = { requestId: 'test' };

beforeAll(async () => {
  api = await createTestApi({ ENABLED_ASSETS: 'eth,xrp', ETHEREUM_RPC_URL: 'http://127.0.0.1:1' });
  await resetDatabase(api.db);
});
afterAll(async () => {
  await api.close();
  await api.db.destroy();
});

async function merchant(label: string): Promise<{ agent: Agent; orgId: string; apiKey: string }> {
  const agent = await signedInUser(api, label);
  const orgId = await createOrg(agent, `${label} shop`);
  keySeq += 1;
  const { wallet, firstAddress } = await createWallet(
    api.db,
    {
      organizationId: orgId,
      actor: { type: 'user', id: agent.userId! },
      chain: 'ethereum',
      network: 'testnet',
      enabledChains: ['ethereum'],
      label: 'ETH',
      accountXpub: HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive(`m/44'/60'/${keySeq}'`)
        .publicExtendedKey,
    },
    meta,
  );
  await confirmWallet(
    api.db,
    {
      organizationId: orgId,
      walletId: wallet.id,
      actor: { type: 'user', id: agent.userId! },
      address: firstAddress.address,
    },
    meta,
  );
  const created = await agent.request('POST', `/v1/organizations/${orgId}/api-keys`, {
    body: {
      name: 'shop',
      scopes: ['invoice:create', 'invoice:read', 'invoice:cancel', 'payment:read'],
    },
  });
  expect(created.statusCode).toBe(201);
  return { agent, orgId, apiKey: created.json<{ key: string }>().key };
}

const call = (
  apiKey: string,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> =>
  api.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${apiKey}`, ...headers },
    ...(payload ? { payload } : {}),
  });

type InvoiceBody = {
  id: string;
  publicId: string;
  status: string;
  amountDue: { asset: string; amount: string; baseUnits: string };
  deposit: {
    address: string;
    destinationTag: number | null;
    paymentUri: string | null;
    chain: string;
  };
  hostedUrl: string;
};

describe('invoice API', () => {
  it('creates, reads and lists invoices with an API key; amounts are exact', async () => {
    const { orgId, apiKey } = await merchant('inv1');
    const created = await call(apiKey, 'POST', `/v1/organizations/${orgId}/invoices`, {
      asset: 'eth',
      amount: '0.000000000000001234',
      externalId: 'order-77',
      description: 'T-shirt',
      metadata: { sku: 'ts-1' },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<InvoiceBody>();
    expect(body.status).toBe('open');
    expect(body.amountDue).toEqual({
      asset: 'eth',
      amount: '0.000000000000001234',
      baseUnits: '1234',
    });
    expect(body.deposit.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(body.deposit.paymentUri).toBe(`ethereum:${body.deposit.address}?value=1234`);
    expect(body.hostedUrl.endsWith(`/pay/${body.publicId}`)).toBe(true);

    const again = await call(apiKey, 'POST', `/v1/organizations/${orgId}/invoices`, {
      asset: 'eth',
      amount: '0.000000000000001234',
      externalId: 'order-77',
    });
    expect(again.json<InvoiceBody>().id).toBe(body.id);

    const got = await call(apiKey, 'GET', `/v1/organizations/${orgId}/invoices/${body.id}`);
    expect(got.statusCode).toBe(200);
    const list = await call(
      apiKey,
      'GET',
      `/v1/organizations/${orgId}/invoices?externalId=order-77`,
    );
    expect(list.json<{ data: unknown[] }>().data).toHaveLength(1);
  });

  it('rejects malformed, rounded, oversized and unknown input', async () => {
    const { orgId, apiKey } = await merchant('inv2');
    const url = `/v1/organizations/${orgId}/invoices`;
    for (const payload of [
      { asset: 'eth', amount: '1e3' },
      { asset: 'eth', amount: '-1' },
      { asset: 'eth', amount: '0' },
      { asset: 'eth', amount: '0.0000000000000000001' }, // 19 decimals
      { asset: 'xrp', amount: '1.0000001' }, // 7 decimals, XRP has 6
      { asset: 'doge', amount: '1' },
      { asset: 'eth', amount: '1', extra: true },
      { asset: 'eth', amount: '1', metadata: { big: 'x'.repeat(3000) } },
    ]) {
      const response = await call(apiKey, 'POST', url, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    // btc is valid input but not enabled in this deployment.
    expect((await call(apiKey, 'POST', url, { asset: 'btc', amount: '1' })).statusCode).toBe(400);
  });

  it('enforces scopes, tenant isolation and cancellation rules', async () => {
    const a = await merchant('inv3a');
    const b = await merchant('inv3b');
    const created = await call(a.apiKey, 'POST', `/v1/organizations/${a.orgId}/invoices`, {
      asset: 'eth',
      amount: '0.001',
    });
    const invoice = created.json<InvoiceBody>();

    // B's key and B's session cannot see A's invoice.
    expect(
      (await call(b.apiKey, 'GET', `/v1/organizations/${a.orgId}/invoices/${invoice.id}`))
        .statusCode,
    ).toBe(404);
    expect(
      (await b.agent.request('GET', `/v1/organizations/${a.orgId}/invoices/${invoice.id}`))
        .statusCode,
    ).toBe(404);
    expect(
      (await call(b.apiKey, 'GET', `/v1/organizations/${b.orgId}/invoices/${invoice.id}`))
        .statusCode,
    ).toBe(404);

    // A key without the cancel scope cannot cancel.
    const limited = await a.agent.request('POST', `/v1/organizations/${a.orgId}/api-keys`, {
      body: { name: 'read only', scopes: ['invoice:read'] },
    });
    const readKey = limited.json<{ key: string }>().key;
    expect(
      (await call(readKey, 'POST', `/v1/organizations/${a.orgId}/invoices/${invoice.id}/cancel`))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await call(readKey, 'POST', `/v1/organizations/${a.orgId}/invoices`, {
          asset: 'eth',
          amount: '1',
        })
      ).statusCode,
    ).toBe(403);

    const cancelled = await call(
      a.apiKey,
      'POST',
      `/v1/organizations/${a.orgId}/invoices/${invoice.id}/cancel`,
    );
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<InvoiceBody>().status).toBe('cancelled');
  });

  it('shows payments on the invoice and in the payments list', async () => {
    const { orgId, apiKey } = await merchant('inv4');
    const invoice = (
      await call(apiKey, 'POST', `/v1/organizations/${orgId}/invoices`, {
        asset: 'eth',
        amount: '0.000000000000001',
      })
    ).json<InvoiceBody>();
    await recordObservation(api.db, {
      chain: 'ethereum',
      network: 'testnet',
      ref: `eth:0x${'ab'.repeat(32)}:native`,
      assetId: 'eth',
      txHash: `0x${'ab'.repeat(32)}`,
      toAddress: invoice.deposit.address,
      amount: 1_000n,
      blockHeight: 5n,
      blockHash: '0xb',
      confirmations: 30n,
      final: true,
    });
    const got = (
      await call(apiKey, 'GET', `/v1/organizations/${orgId}/invoices/${invoice.id}`)
    ).json<InvoiceBody & { payments: { status: string; amount: { baseUnits: string } }[] }>();
    expect(got.status).toBe('paid');
    expect(got.payments).toHaveLength(1);
    expect(got.payments[0]?.status).toBe('confirmed');
    const payments = await call(apiKey, 'GET', `/v1/organizations/${orgId}/payments`);
    expect(payments.json<{ data: unknown[] }>().data).toHaveLength(1);
  });
});

describe('public endpoints and payment links', () => {
  it('serves the hosted invoice view with only payer-safe fields', async () => {
    const { orgId, apiKey } = await merchant('pub1');
    const invoice = (
      await call(apiKey, 'POST', `/v1/organizations/${orgId}/invoices`, {
        asset: 'eth',
        amount: '0.5',
        description: 'Order #5',
        metadata: { internalNote: 'do not leak' },
        externalId: 'secret-order-ref',
      })
    ).json<InvoiceBody>();
    const view = await api.app.inject({
      method: 'GET',
      url: `/v1/public/invoices/${invoice.publicId}`,
    });
    expect(view.statusCode).toBe(200);
    expect(view.body).not.toContain('do not leak');
    expect(view.body).not.toContain('secret-order-ref');
    expect(view.json<{ merchant: string; deposit: { address: string } }>()).toMatchObject({
      merchant: 'pub1 shop',
      deposit: { address: invoice.deposit.address },
    });
    // The internal id is not accepted on the public route, and guesses 404.
    expect(
      (await api.app.inject({ method: 'GET', url: `/v1/public/invoices/${invoice.id}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await api.app.inject({ method: 'GET', url: `/v1/public/invoices/${'z'.repeat(32)}` }))
        .statusCode,
    ).toBe(404);
  });

  it('creates payment links (session only) and turns visits into invoices, capped per link', async () => {
    const { agent, orgId, apiKey } = await merchant('pub2');
    const link = await agent.request('POST', `/v1/organizations/${orgId}/payment-links`, {
      body: { asset: 'eth', amount: '0.01', title: 'Donate', maxOpenInvoices: 2 },
    });
    expect(link.statusCode).toBe(201);
    const { id, publicId } = link.json<{ id: string; publicId: string }>();

    // API keys cannot manage links.
    expect(
      (
        await call(apiKey, 'POST', `/v1/organizations/${orgId}/payment-links`, {
          asset: 'eth',
          amount: '1',
          title: 'x',
        })
      ).statusCode,
    ).toBe(403);

    const info = await api.app.inject({
      method: 'GET',
      url: `/v1/public/payment-links/${publicId}`,
    });
    expect(info.json<{ title: string; amount: { amount: string } }>()).toMatchObject({
      title: 'Donate',
      amount: { amount: '0.01' },
    });

    const start = () =>
      api.app.inject({ method: 'POST', url: `/v1/public/payment-links/${publicId}/invoices` });
    const first = await start();
    expect(first.statusCode).toBe(201);
    const second = await start();
    expect(second.statusCode).toBe(201);
    expect(first.json<{ publicId: string }>().publicId).not.toBe(
      second.json<{ publicId: string }>().publicId,
    );
    expect((await start()).statusCode).toBe(429); // cap of two unpaid invoices

    // The visitor's invoice shows the link's price and belongs to the merchant.
    const view = await api.app.inject({
      method: 'GET',
      url: `/v1/public/invoices/${first.json<{ publicId: string }>().publicId}`,
    });
    expect(view.json<{ amountDue: { amount: string } }>().amountDue.amount).toBe('0.01');
    const list = await call(apiKey, 'GET', `/v1/organizations/${orgId}/invoices`);
    expect(list.json<{ data: unknown[] }>().data).toHaveLength(2);

    // Deactivating the link stops new invoices.
    expect(
      (await agent.request('POST', `/v1/organizations/${orgId}/payment-links/${id}/deactivate`))
        .statusCode,
    ).toBe(200);
    expect((await start()).statusCode).toBe(404);
    expect(
      (await api.app.inject({ method: 'GET', url: `/v1/public/payment-links/${publicId}` }))
        .statusCode,
    ).toBe(404);
  });

  it("hides one organization's payment links from another", async () => {
    const a = await merchant('pub3a');
    const b = await merchant('pub3b');
    const link = await a.agent.request('POST', `/v1/organizations/${a.orgId}/payment-links`, {
      body: { asset: 'eth', amount: '1', title: 'A only' },
    });
    const { id } = link.json<{ id: string }>();
    expect(
      (await b.agent.request('GET', `/v1/organizations/${a.orgId}/payment-links`)).statusCode,
    ).toBe(404);
    expect(
      (await b.agent.request('POST', `/v1/organizations/${b.orgId}/payment-links/${id}/deactivate`))
        .statusCode,
    ).toBe(404);
  });
});
