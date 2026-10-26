/**
 * Webhooks end to end: fan-out in the event's own transaction, signed delivery to
 * a real local receiver, retries, secret rotation, SSRF defences, claims, and the API.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SecretBox } from '@actualpay/auth';
import { inTransaction, type Db } from '@actualpay/database';
import { recordEvent } from '@actualpay/payments';
import { createLogger } from '@actualpay/shared';
import {
  createEndpoint,
  deliverDue,
  listDeliveries,
  MAX_ATTEMPTS,
  postJson,
  redeliver,
  RETRY_DELAYS_SECONDS,
  rotateSecret,
  sendTest,
  updateEndpoint,
  verifySignature,
  type UrlPolicy,
} from '@actualpay/webhooks';
import { createOrg, createTestApi, signedInUser, type TestApi } from './api-helpers';
import { createOrganization, createTestDb, resetDatabase } from './helpers';

const logger = createLogger({ name: 'test', level: 'silent' });
const meta = { requestId: 'test' };
const DEV: UrlPolicy = { allowHttp: true, allowPrivateNetworks: true };
const STRICT: UrlPolicy = { allowHttp: false, allowPrivateNetworks: false };
const box = new SecretBox(Buffer.alloc(32, 7), 'webhooks');

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

async function receiver(
  handler: (req: Received, res: ServerResponse, count: number) => void,
): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const item = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      received.push(item);
      handler(item, res, received.length);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

let db: Db;
let userId: string;
let orgId: string;

beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await resetDatabase(db);
  userId = (
    await db
      .insertInto('users')
      .values({
        email: 'hooks@example.test',
        password_hash: '$argon2id$v=19$m=19456,t=2,p=1$dGVzdA$dGVzdA',
        display_name: 'Hooks',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  orgId = await createOrganization(db);
});

const actor = () => ({ type: 'user', id: userId }) as const;
const emit = (
  type: 'invoice.paid' | 'invoice.created' | 'payment.confirmed' = 'invoice.paid',
  org = orgId,
) =>
  inTransaction(db, (tx) =>
    recordEvent(tx, {
      organizationId: org,
      type,
      subjectType: 'invoice',
      subjectId: 'inv-1',
      payload: { invoiceId: 'inv-1', n: 1 },
    }),
  );
const create = (url: string, eventTypes: string[] = ['*'], policy = DEV, org = orgId) =>
  createEndpoint(db, { organizationId: org, actor: actor(), url, eventTypes, box, policy }, meta);
const deliver = (
  now: Date,
  policy: UrlPolicy = DEV,
  extra: { resolver?: (h: string) => Promise<string[]> } = {},
) => deliverDue({ db, box, logger, policy, now, ...extra });
const delivery = async () =>
  db.selectFrom('webhook_deliveries').selectAll().orderBy('created_at').execute();

describe('endpoints', () => {
  it('shows the secret once and stores it encrypted', async () => {
    const { endpoint, secret } = await create('http://127.0.0.1:9/hook');
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(endpoint.secret_ciphertext.startsWith('v1.')).toBe(true);
    expect(endpoint.secret_ciphertext).not.toContain(secret);
    const stored = await db.selectFrom('webhook_endpoints').selectAll().execute();
    expect(JSON.stringify(stored)).not.toContain(secret);
  });

  it('refuses unsafe URLs, unknown events and too many endpoints', async () => {
    for (const url of [
      'http://hooks.example.com/x',
      'https://127.0.0.1/x',
      'https://169.254.169.254/x',
      'https://user:p@hooks.example.com/',
    ])
      await expect(create(url, ['*'], STRICT)).rejects.toThrow();
    await expect(create('https://hooks.example.com/x', ['nope.event'], STRICT)).rejects.toThrow(
      /Unknown event type/,
    );
    await expect(create('https://hooks.example.com/x', ['webhook.test'], STRICT)).rejects.toThrow(
      /test button/,
    );
    await expect(create('https://hooks.example.com/x', [], STRICT)).rejects.toThrow(/at least one/);
    for (let i = 0; i < 20; i++) await create(`https://hooks.example.com/${i}`, ['*'], STRICT);
    await expect(create('https://hooks.example.com/21', ['*'], STRICT)).rejects.toThrow(
      /at most 20/,
    );
  });

  it('re-validates the URL when it is changed', async () => {
    const { endpoint } = await create('https://hooks.example.com/a', ['*'], STRICT);
    await expect(
      updateEndpoint(
        db,
        {
          organizationId: orgId,
          endpointId: endpoint.id,
          actor: actor(),
          url: 'https://10.0.0.1/x',
          policy: STRICT,
        },
        meta,
      ),
    ).rejects.toThrow(/private/);
  });
});

describe('fan-out', () => {
  it('queues deliveries only for active, subscribed endpoints of the same organization', async () => {
    const other = await createOrganization(db);
    const all = await create('https://hooks.example.com/all', ['*'], STRICT);
    const paidOnly = await create('https://hooks.example.com/paid', ['invoice.paid'], STRICT);
    const createdOnly = await create(
      'https://hooks.example.com/created',
      ['invoice.created'],
      STRICT,
    );
    const disabled = await create('https://hooks.example.com/off', ['*'], STRICT);
    await updateEndpoint(
      db,
      {
        organizationId: orgId,
        endpointId: disabled.endpoint.id,
        actor: actor(),
        status: 'disabled',
        policy: STRICT,
      },
      meta,
    );
    await create('https://hooks.example.com/other-org', ['*'], STRICT, other);

    await emit('invoice.paid');
    const queued = (await delivery()).map((d) => d.endpoint_id).sort();
    expect(queued).toEqual([all.endpoint.id, paidOnly.endpoint.id].sort());
    expect(queued).not.toContain(createdOnly.endpoint.id);
  });

  it('creates the delivery in the same transaction as the event (rolls back together)', async () => {
    await create('https://hooks.example.com/x', ['*'], STRICT);
    await expect(
      inTransaction(
        db,
        async (tx) => {
          await recordEvent(tx, {
            organizationId: orgId,
            type: 'invoice.paid',
            subjectType: 'invoice',
            subjectId: 'i',
            payload: {},
          });
          throw new Error('the business change failed');
        },
        { maxAttempts: 1 },
      ),
    ).rejects.toThrow(/business change failed/);
    expect(await delivery()).toHaveLength(0);
    expect(await db.selectFrom('domain_events').select('id').execute()).toHaveLength(0);
  });
});

describe('delivery', () => {
  it('sends a signed, well-formed request and marks it delivered exactly once', async () => {
    const r = await receiver((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });
    try {
      const { secret } = await create(`${r.url}/hooks/actualpay?x=1`);
      const eventId = await emit();
      const now = new Date();
      const first = await deliver(now);
      expect(first).toMatchObject({ attempted: 1, delivered: 1 });
      expect(r.received).toHaveLength(1);
      const req = r.received[0]!;
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/hooks/actualpay?x=1');
      expect(req.headers['content-type']).toBe('application/json');
      expect(req.headers['actualpay-event-id']).toBe(`evt_${eventId}`);
      expect(req.headers['actualpay-event-type']).toBe('invoice.paid');
      expect(req.headers['actualpay-delivery-attempt']).toBe('1');
      const signature = req.headers['actualpay-signature'] as string;
      expect(
        verifySignature({
          header: signature,
          body: req.body,
          secret,
          nowSeconds: Math.floor(now.getTime() / 1000),
        }),
      ).toBe(true);
      const envelope = JSON.parse(req.body) as {
        id: string;
        type: string;
        organizationId: string;
        data: { invoiceId: string };
        subject: { type: string };
      };
      expect(envelope).toMatchObject({
        id: `evt_${eventId}`,
        type: 'invoice.paid',
        organizationId: orgId,
        subject: { type: 'invoice' },
        data: { invoiceId: 'inv-1' },
      });

      expect((await delivery())[0]).toMatchObject({
        status: 'delivered',
        attempts: 1,
        last_status_code: 200,
      });
      expect((await deliver(new Date(now.getTime() + 60_000))).attempted).toBe(0);
      expect(r.received).toHaveLength(1);
    } finally {
      await r.close();
    }
  });

  it('retries on failure with the documented schedule, then succeeds and clears the failure count', async () => {
    let status = 500;
    const r = await receiver((_req, res) => {
      res.statusCode = status;
      res.end();
    });
    try {
      const { endpoint } = await create(r.url);
      await emit();
      const t0 = new Date();
      expect(await deliver(t0)).toMatchObject({ attempted: 1, retried: 1 });
      let row = (await delivery())[0]!;
      expect(row).toMatchObject({
        status: 'pending',
        attempts: 1,
        last_status_code: 500,
        last_error: 'HTTP 500',
      });
      expect(row.next_attempt_at.getTime() - t0.getTime()).toBe(RETRY_DELAYS_SECONDS[0]! * 1000);

      // Not due yet: nothing is sent.
      expect((await deliver(new Date(t0.getTime() + 10_000))).attempted).toBe(0);

      status = 200;
      const t1 = new Date(t0.getTime() + RETRY_DELAYS_SECONDS[0]! * 1000 + 1);
      expect(await deliver(t1)).toMatchObject({ attempted: 1, delivered: 1 });
      row = (await delivery())[0]!;
      expect(row).toMatchObject({ status: 'delivered', attempts: 2 });
      expect(r.received.map((x) => x.headers['actualpay-delivery-attempt'])).toEqual(['1', '2']);
      const ep = await db
        .selectFrom('webhook_endpoints')
        .select('consecutive_failures')
        .where('id', '=', endpoint.id)
        .executeTakeFirstOrThrow();
      expect(ep.consecutive_failures).toBe(0);
    } finally {
      await r.close();
    }
  });

  it('gives up after the final attempt and can be re-sent by hand', async () => {
    let status = 503;
    const r = await receiver((_req, res) => {
      res.statusCode = status;
      res.end();
    });
    try {
      await create(r.url);
      await emit();
      let now = new Date();
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await deliver(now);
        now = new Date(now.getTime() + 86_400_000 + 1000);
      }
      const row = (await delivery())[0]!;
      expect(row).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
      expect(r.received).toHaveLength(MAX_ATTEMPTS);
      expect((await deliver(now)).attempted).toBe(0);

      status = 200;
      await redeliver(db, { organizationId: orgId, deliveryId: row.id, actor: actor() }, meta);
      expect(await deliver(new Date(now.getTime() + 1000))).toMatchObject({ delivered: 1 });
      expect((await delivery())[0]).toMatchObject({ status: 'delivered', attempts: 1 });
    } finally {
      await r.close();
    }
  });

  it('disables an endpoint that answers 410 Gone and stops sending to disabled endpoints', async () => {
    const r = await receiver((_req, res) => {
      res.statusCode = 410;
      res.end();
    });
    try {
      const { endpoint } = await create(r.url);
      await emit();
      await deliver(new Date());
      const ep = await db
        .selectFrom('webhook_endpoints')
        .selectAll()
        .where('id', '=', endpoint.id)
        .executeTakeFirstOrThrow();
      expect(ep.status).toBe('disabled');
      expect(ep.disabled_reason).toMatch(/410/);
      const audit = await db
        .selectFrom('audit_log')
        .select('action')
        .where('target_id', '=', endpoint.id)
        .execute();
      expect(audit.map((a) => a.action)).toContain('webhook.endpoint_auto_disabled');
      await emit();
      expect((await deliver(new Date(Date.now() + 3_600_000))).attempted).toBe(0);
      expect(r.received).toHaveLength(1);
    } finally {
      await r.close();
    }
  });

  it('disables an endpoint after many consecutive failures', async () => {
    const r = await receiver((_req, res) => {
      res.statusCode = 500;
      res.end();
    });
    try {
      const { endpoint } = await create(r.url);
      await db
        .updateTable('webhook_endpoints')
        .set({ consecutive_failures: 49 })
        .where('id', '=', endpoint.id)
        .execute();
      await emit();
      await deliver(new Date());
      const ep = await db
        .selectFrom('webhook_endpoints')
        .select(['status', 'disabled_reason'])
        .where('id', '=', endpoint.id)
        .executeTakeFirstOrThrow();
      expect(ep.status).toBe('disabled');
      expect(ep.disabled_reason).toMatch(/50 consecutive/);
    } finally {
      await r.close();
    }
  });

  it('never delivers one event twice when workers race', async () => {
    const r = await receiver((_req, res) => {
      res.statusCode = 200;
      res.end();
    });
    try {
      await create(r.url);
      for (let i = 0; i < 12; i++) await emit();
      const now = new Date();
      await Promise.all(Array.from({ length: 4 }, () => deliver(now)));
      expect(r.received).toHaveLength(12);
      const ids = r.received.map((x) => x.headers['actualpay-delivery-id']);
      expect(new Set(ids).size).toBe(12);
    } finally {
      await r.close();
    }
  });

  it('does not follow redirects', async () => {
    const r = await receiver((req, res) => {
      if (req.url === '/hook') {
        res.statusCode = 302;
        res.setHeader('Location', '/elsewhere');
        res.end();
      } else {
        res.statusCode = 200;
        res.end();
      }
    });
    try {
      await create(`${r.url}/hook`);
      await emit();
      expect(await deliver(new Date())).toMatchObject({ retried: 1 });
      expect(r.received.map((x) => x.url)).toEqual(['/hook']);
      expect((await delivery())[0]).toMatchObject({ last_status_code: 302 });
    } finally {
      await r.close();
    }
  });

  it('times out slow receivers', async () => {
    const r = await receiver(() => undefined); // never answers
    try {
      const result = await postJson({
        url: `${r.url}/slow`,
        body: '{}',
        headers: {},
        policy: DEV,
        timeoutMs: 200,
      });
      expect(result).toEqual({ ok: false, error: 'timeout' });
    } finally {
      await r.close();
    }
  });

  it('records only fixed error phrases, never what the receiver says', async () => {
    const r = await receiver((_req, res) => {
      res.statusCode = 500;
      res.end('SECRET-INTERNAL-ERROR-DETAILS');
    });
    try {
      await create(r.url);
      await emit();
      await deliver(new Date());
      const row = (await delivery())[0]!;
      expect(JSON.stringify(row)).not.toContain('SECRET-INTERNAL');
    } finally {
      await r.close();
    }
  });
});

describe('SSRF at delivery time', () => {
  it('refuses private destinations even if a stored URL predates the policy, and sends nothing', async () => {
    const r = await receiver((_req, res) => {
      res.statusCode = 200;
      res.end();
    });
    try {
      await create(r.url, ['*'], DEV); // registered while development rules were on
      await emit();
      const summary = await deliver(new Date(), STRICT); // delivered under production rules
      expect(summary).toMatchObject({ attempted: 1, retried: 1 });
      expect(r.received).toHaveLength(0);
      expect((await delivery())[0]).toMatchObject({ last_error: 'destination not allowed' });
    } finally {
      await r.close();
    }
  });

  it('refuses a host name that resolves to a private address (DNS rebinding)', async () => {
    const calls: string[] = [];
    const rebind = (host: string) => {
      calls.push(host);
      return Promise.resolve(['127.0.0.1']);
    };
    const result = await postJson({
      url: 'https://innocent.example.com/hook',
      body: '{}',
      headers: {},
      policy: STRICT,
      resolver: rebind,
    });
    expect(result).toEqual({ ok: false, error: 'destination not allowed' });
    expect(calls).toEqual(['innocent.example.com']);
  });

  it('refuses when ANY resolved address is private, even if another is public', async () => {
    const mixed = () => Promise.resolve(['93.184.216.34', '169.254.169.254']);
    const result = await postJson({
      url: 'https://mixed.example.com/hook',
      body: '{}',
      headers: {},
      policy: STRICT,
      resolver: mixed,
    });
    expect(result).toEqual({ ok: false, error: 'destination not allowed' });
  });

  it('reports unresolvable hosts as a lookup failure', async () => {
    const none = () => Promise.reject(new Error('ENOTFOUND'));
    expect(
      await postJson({
        url: 'https://nope.example.com/h',
        body: '{}',
        headers: {},
        policy: STRICT,
        resolver: none,
      }),
    ).toEqual({ ok: false, error: 'dns lookup failed' });
    expect(
      await postJson({
        url: 'https://empty.example.com/h',
        body: '{}',
        headers: {},
        policy: STRICT,
        resolver: () => Promise.resolve([]),
      }),
    ).toEqual({ ok: false, error: 'destination not allowed' });
  });
});

describe('secret rotation, test pings and redelivery', () => {
  it('signs with both secrets during the grace period, then only the new one', async () => {
    const r = await receiver((_req, res) => {
      res.statusCode = 200;
      res.end();
    });
    try {
      const { endpoint, secret: oldSecret } = await create(r.url);
      const t0 = new Date();
      const { secret: newSecret } = await rotateSecret(
        db,
        { organizationId: orgId, endpointId: endpoint.id, actor: actor(), box, now: t0 },
        meta,
      );
      expect(newSecret).not.toBe(oldSecret);

      await emit();
      await deliver(new Date(t0.getTime() + 5000));
      const header1 = r.received[0]!.headers['actualpay-signature'] as string;
      expect(header1.match(/v1=/g)).toHaveLength(2);
      const nowSec = Math.floor((t0.getTime() + 5000) / 1000);
      for (const secret of [oldSecret, newSecret])
        expect(
          verifySignature({
            header: header1,
            body: r.received[0]!.body,
            secret,
            nowSeconds: nowSec,
          }),
        ).toBe(true);

      await emit();
      const later = new Date(t0.getTime() + 25 * 3_600_000);
      await deliver(later);
      const header2 = r.received[1]!.headers['actualpay-signature'] as string;
      expect(header2.match(/v1=/g)).toHaveLength(1);
      const laterSec = Math.floor(later.getTime() / 1000);
      expect(
        verifySignature({
          header: header2,
          body: r.received[1]!.body,
          secret: newSecret,
          nowSeconds: laterSec,
        }),
      ).toBe(true);
      expect(
        verifySignature({
          header: header2,
          body: r.received[1]!.body,
          secret: oldSecret,
          nowSeconds: laterSec,
        }),
      ).toBe(false);
    } finally {
      await r.close();
    }
  });

  it('sends a test event to one endpoint only and lists deliveries', async () => {
    const r = await receiver((_req, res) => {
      res.statusCode = 200;
      res.end();
    });
    try {
      const target = await create(`${r.url}/a`);
      await create(`${r.url}/b`);
      await sendTest(
        db,
        { organizationId: orgId, endpointId: target.endpoint.id, actor: actor() },
        meta,
      );
      await deliver(new Date());
      expect(r.received.map((x) => x.url)).toEqual(['/a']);
      expect(r.received[0]!.headers['actualpay-event-type']).toBe('webhook.test');
      const list = await listDeliveries(db, {
        organizationId: orgId,
        endpointId: target.endpoint.id,
        limit: 10,
      });
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ event_type: 'webhook.test', status: 'delivered' });
      // Another organization sees nothing of it.
      const stranger = await createOrganization(db);
      expect(
        await listDeliveries(db, {
          organizationId: stranger,
          endpointId: target.endpoint.id,
          limit: 10,
        }),
      ).toHaveLength(0);
      await expect(
        redeliver(db, { organizationId: stranger, deliveryId: list[0]!.id, actor: actor() }, meta),
      ).rejects.toThrow(/not found/i);
    } finally {
      await r.close();
    }
  });
});

describe('HTTP API', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi();
  });
  afterAll(async () => {
    await api.close();
    await api.db.destroy();
  });

  it('manages endpoints with an API key, shows the secret once, and isolates organizations', async () => {
    await resetDatabase(api.db);
    const owner = await signedInUser(api, 'hookowner');
    const org = await createOrg(owner, 'Hook Org');
    const keyRes = await owner.request('POST', `/v1/organizations/${org}/api-keys`, {
      body: { name: 'hooks', scopes: ['webhook:manage', 'webhook:read'] },
    });
    const apiKey = keyRes.json<{ key: string }>().key;
    const call = (
      method: 'GET' | 'POST' | 'PATCH',
      url: string,
      payload?: Record<string, unknown>,
    ) =>
      api.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${apiKey}` },
        ...(payload ? { payload } : {}),
      });

    // Default (production-like) policy: unsafe destinations are refused.
    for (const url of [
      'http://hooks.example.com/x',
      'https://127.0.0.1/x',
      'https://10.0.0.5/x',
      'https://localhost/x',
    ])
      expect(
        (await call('POST', `/v1/organizations/${org}/webhooks`, { url })).statusCode,
        url,
      ).toBe(400);

    const created = await call('POST', `/v1/organizations/${org}/webhooks`, {
      url: 'https://hooks.example.com/actualpay',
      eventTypes: ['invoice.paid', 'payment.confirmed'],
      description: 'orders',
    });
    expect(created.statusCode).toBe(201);
    const { endpoint, secret } = created.json<{
      endpoint: { id: string; eventTypes: string[] };
      secret: string;
    }>();
    expect(secret).toMatch(/^whsec_/);
    expect(endpoint.eventTypes).toEqual(['invoice.paid', 'payment.confirmed']);

    const list = await call('GET', `/v1/organizations/${org}/webhooks`);
    expect(list.body).not.toContain(secret);
    expect(list.body).not.toContain('secret_ciphertext');
    expect(
      (await call('GET', `/v1/organizations/${org}/webhooks/${endpoint.id}`)).body,
    ).not.toContain(secret);

    const rotated = await call(
      'POST',
      `/v1/organizations/${org}/webhooks/${endpoint.id}/rotate-secret`,
    );
    expect(rotated.json<{ secret: string }>().secret).not.toBe(secret);
    const disabled = await call('PATCH', `/v1/organizations/${org}/webhooks/${endpoint.id}`, {
      status: 'disabled',
    });
    expect(disabled.json<{ status: string }>().status).toBe('disabled');
    expect(
      (await call('POST', `/v1/organizations/${org}/webhooks/${endpoint.id}/test`)).statusCode,
    ).toBe(409);

    // A key limited to reading cannot manage; another organization sees nothing.
    const readKey = (
      await owner.request('POST', `/v1/organizations/${org}/api-keys`, {
        body: { name: 'ro', scopes: ['webhook:read'] },
      })
    ).json<{ key: string }>().key;
    const asRead = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
      api.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${readKey}` },
        ...(payload ? { payload } : {}),
      });
    expect((await asRead('GET', `/v1/organizations/${org}/webhooks`)).statusCode).toBe(200);
    expect(
      (
        await asRead('POST', `/v1/organizations/${org}/webhooks`, {
          url: 'https://hooks.example.com/y',
        })
      ).statusCode,
    ).toBe(403);

    const other = await signedInUser(api, 'hookother');
    await createOrg(other, 'Other');
    expect((await other.request('GET', `/v1/organizations/${org}/webhooks`)).statusCode).toBe(404);
    expect(
      (await other.request('GET', `/v1/organizations/${org}/webhooks/${endpoint.id}`)).statusCode,
    ).toBe(404);
  });
});
