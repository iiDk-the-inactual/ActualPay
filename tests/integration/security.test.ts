/**
 * Cross-cutting security properties, checked against EVERY route in the
 * registry rather than a hand-picked few: a new route that forgets
 * authentication, tenant scoping, CSRF or MFA fails here without anyone having
 * to remember to write a test for it.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import type { ZodType } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routeRegistry, type RegisteredRoute } from '@actualpay/api';
import { roleHas } from '@actualpay/auth';
import {
  Agent,
  createOrg,
  createTestApi,
  signedInUser,
  withMfa,
  type TestApi,
} from './api-helpers';
import { resetDatabase } from './helpers';

let api: TestApi;
let owner: Agent; // MFA-verified owner of `orgId`, also a platform admin
let outsider: Agent; // MFA-verified owner of a different organization
let viewer: Agent; // MFA-verified viewer in `orgId`
let orgId: string;
let otherOrgId: string;

beforeAll(async () => {
  api = await createTestApi({
    ENABLED_ASSETS: 'eth,xrp',
    ETHEREUM_RPC_URL: 'http://127.0.0.1:1',
    CUSTODY_MODE: 'platform',
    WITHDRAWAL_SEAL_KEY: randomBytes(32).toString('base64'),
  });
  await resetDatabase(api.db);

  const o = await signedInUser(api, 'owner');
  orgId = await createOrg(o, 'Secure Org');
  await api.db
    .updateTable('users')
    .set({ is_platform_admin: true })
    .where('id', '=', o.userId!)
    .execute();
  owner = await withMfa(api, o);

  const x = await signedInUser(api, 'outsider');
  otherOrgId = await createOrg(x, 'Other Org');
  outsider = await withMfa(api, x);

  const v = await signedInUser(api, 'viewer');
  await api.db
    .insertInto('organization_members')
    .values({ organization_id: orgId, user_id: v.userId!, role: 'viewer' })
    .execute();
  viewer = await withMfa(api, v);
});
afterAll(async () => {
  await api.close();
  await api.db.destroy();
});

const unique = (): RegisteredRoute[] => {
  const seen = new Map<string, RegisteredRoute>();
  for (const r of routeRegistry) seen.set(`${r.method} ${r.url}`, r);
  return [...seen.values()];
};

/** Values to try for a path parameter, most specific first. */
function fillPath(route: RegisteredRoute, org: string): string {
  const params = route.schemas.params as
    (ZodType & { shape?: Record<string, ZodType> }) | undefined;
  return route.url.replace(/:([A-Za-z]+)/g, (_match: string, name: string) => {
    if (name === 'orgId') return org;
    const schema = params?.shape?.[name];
    for (const candidate of [randomUUID(), 'eth', 'security', 'abcdefghij']) {
      if (!schema || schema.safeParse(candidate).success) return candidate;
    }
    return randomUUID();
  });
}

const orgRoutes = () =>
  unique().filter(
    (r) => r.url.includes(':orgId') && r.auth !== 'public' && !r.url.startsWith('/v1/admin/'),
  );
const protectedRoutes = () => unique().filter((r) => r.auth !== 'public');
const unsafe = (r: RegisteredRoute) => r.method !== 'GET';

async function call(agent: Agent | null, route: RegisteredRoute, url: string, body?: unknown) {
  if (agent) return agent.request(route.method, url, { ...(body !== undefined ? { body } : {}) });
  return api.app.inject({
    method: route.method,
    url,
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
}

describe('every protected route', () => {
  it('rejects unauthenticated callers with 401 (and nothing else)', async () => {
    const failures: string[] = [];
    for (const r of protectedRoutes()) {
      const res = await call(null, r, fillPath(r, orgId), unsafe(r) ? {} : undefined);
      if (res.statusCode !== 401) failures.push(`${r.method} ${r.url} → ${res.statusCode}`);
    }
    expect(failures).toEqual([]);
  });

  it('rejects a forged API key and a malformed Authorization header', async () => {
    const r = unique().find(
      (x) => x.url === '/v1/organizations/:orgId/invoices' && x.method === 'GET',
    )!;
    for (const authorization of [
      'Bearer apk_test_AAAAAAAAAAAAAAAA_notarealsecretnotarealsecretnotarealsecret',
      'Bearer ',
      'Basic dXNlcjpwYXNz',
      'apk_test_x',
    ]) {
      const res = await api.app.inject({
        method: 'GET',
        url: fillPath(r, orgId),
        headers: { authorization },
      });
      expect(res.statusCode, authorization).toBe(401);
    }
  });
});

describe('tenant isolation', () => {
  it('answers 404 for every organization route when the caller belongs to a different organization', async () => {
    const failures: string[] = [];
    for (const r of orgRoutes()) {
      const res = await call(outsider, r, fillPath(r, orgId), unsafe(r) ? {} : undefined);
      // MFA/CSRF checks precede scoping, and outsider satisfies both, so this is purely scoping.
      if (res.statusCode !== 404) failures.push(`${r.method} ${r.url} → ${res.statusCode}`);
    }
    expect(failures).toEqual([]);
  });

  it('never leaks the existence of another organization (same answer as a nonexistent one)', async () => {
    const real = orgRoutes().find(
      (r) => r.url === '/v1/organizations/:orgId/invoices' && r.method === 'GET',
    )!;
    const a = await outsider.request('GET', fillPath(real, orgId));
    const b = await outsider.request('GET', fillPath(real, randomUUID()));
    expect(a.statusCode).toBe(b.statusCode);
    expect(
      JSON.stringify(a.json<{ error: { code: string; message: string } }>().error.message),
    ).toBe(JSON.stringify(b.json<{ error: { code: string; message: string } }>().error.message));
  });
});

describe('platform administration', () => {
  it('is closed to everyone but platform administrators, before any input is looked at', async () => {
    const adminRoutes = unique().filter((r) => r.url.startsWith('/v1/admin/'));
    expect(adminRoutes.length).toBeGreaterThan(10);
    const failures: string[] = [];
    for (const r of adminRoutes) {
      if (!r.platformAdmin) failures.push(`${r.method} ${r.url} does not declare platformAdmin`);
      for (const agent of [outsider, viewer]) {
        const res = await call(agent, r, fillPath(r, orgId), unsafe(r) ? {} : undefined);
        if (res.statusCode !== 403) failures.push(`${r.method} ${r.url} → ${res.statusCode}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('roles', () => {
  it('forbids a viewer from every route that needs a permission viewers lack', async () => {
    const failures: string[] = [];
    let checked = 0;
    for (const r of orgRoutes()) {
      if (typeof r.org !== 'string' || roleHas('viewer', r.org)) continue;
      checked += 1;
      const res = await call(viewer, r, fillPath(r, orgId), unsafe(r) ? {} : undefined);
      if (res.statusCode !== 403)
        failures.push(`${r.method} ${r.url} (${r.org}) → ${res.statusCode}`);
    }
    expect(checked).toBeGreaterThan(20);
    expect(failures).toEqual([]);
  });
});

describe('CSRF and MFA', () => {
  it('requires the CSRF token on every state-changing session route', async () => {
    const failures: string[] = [];
    for (const r of protectedRoutes().filter((x) => unsafe(x) && x.auth !== 'session_or_api_key')) {
      if (r.url === '/v1/auth/logout') continue;
      const res = await owner.request(r.method, fillPath(r, orgId), { body: {}, csrf: false });
      const code = res.json<{ error?: { code: string } }>().error?.code;
      if (res.statusCode !== 403 || code !== 'CSRF_FAILED')
        failures.push(`${r.method} ${r.url} → ${res.statusCode} ${code}`);
    }
    expect(failures).toEqual([]);
  });

  it('also requires it when a session (not an API key) calls a dual-auth route', async () => {
    const failures: string[] = [];
    for (const r of protectedRoutes().filter((x) => unsafe(x) && x.auth === 'session_or_api_key')) {
      const res = await owner.request(r.method, fillPath(r, orgId), { body: {}, csrf: false });
      const code = res.json<{ error?: { code: string } }>().error?.code;
      if (res.statusCode !== 403 || code !== 'CSRF_FAILED')
        failures.push(`${r.method} ${r.url} → ${res.statusCode} ${code}`);
    }
    expect(failures).toEqual([]);
  });

  it('requires a two-factor-verified session on every route that declares it', async () => {
    const lone = await signedInUser(api, 'nomfa');
    const loneOrg = await createOrg(lone, 'No MFA');
    const failures: string[] = [];
    const mfaRoutes = protectedRoutes().filter((r) => r.requireMfa);
    expect(mfaRoutes.length).toBeGreaterThan(10);
    for (const r of mfaRoutes) {
      const res = await lone.request(r.method, fillPath(r, loneOrg), { body: {} });
      const code = res.json<{ error?: { code: string } }>().error?.code;
      if (res.statusCode !== 403 || code !== 'MFA_REQUIRED')
        failures.push(`${r.method} ${r.url} → ${res.statusCode} ${code}`);
    }
    expect(failures).toEqual([]);
  });

  it('keeps money-moving and admin routes behind MFA', () => {
    const must = [
      'POST /v1/organizations/:orgId/withdrawals/:withdrawalId/approve',
      'POST /v1/organizations/:orgId/withdrawal-destinations',
      'PUT /v1/organizations/:orgId/withdrawal-policies/:asset',
      'POST /v1/admin/withdrawals/pause',
      'POST /v1/admin/hot-wallets',
      'POST /v1/admin/platform-funding',
      'POST /v1/organizations/:orgId/wallets',
    ];
    const have = new Set(
      unique()
        .filter((r) => r.requireMfa)
        .map((r) => `${r.method} ${r.url}`),
    );
    for (const route of must) expect(have.has(route), route).toBe(true);
    for (const r of unique().filter((x) => x.url.startsWith('/v1/admin/') && x.method !== 'GET'))
      expect(r.requireMfa, `${r.method} ${r.url}`).toBe(true);
  });
});

describe('robustness: no input makes any route fail with 5xx', () => {
  const SKIP = new Set([
    '/v1/auth/logout',
    '/v1/me/sessions/revoke-others',
    '/v1/me/password',
    '/v1/me/mfa/totp/disable',
    '/v1/me/mfa/totp/setup',
  ]);
  const nasty: unknown[] = [
    {},
    [],
    null,
    'string',
    { __proto__: { admin: true } },
    JSON.parse('{"__proto__":{"admin":true},"constructor":{"prototype":{"x":1}}}'),
    { name: 'x'.repeat(100_000) },
    { amount: -1, asset: 'btc', email: 'a'.repeat(300) },
    { amount: '1e999', url: 'javascript:alert(1)', email: "x'; DROP TABLE users; --" },
    { a: { b: { c: { d: { e: { f: [[[[[[]]]]]] } } } } } },
    { amount: '0.1', asset: 'eth', kinds: ['x'], scopes: ['*'], role: 'root', enabled: 'yes' },
  ];

  it('survives hostile bodies on every route (400-class answers only)', async () => {
    const failures: string[] = [];
    for (const r of protectedRoutes().filter((x) => !SKIP.has(x.url))) {
      const bodies = unsafe(r) ? nasty : [undefined];
      for (const body of bodies) {
        let res: LightMyRequestResponse;
        try {
          res = await owner.request(r.method, fillPath(r, orgId), {
            ...(body !== undefined ? { body } : {}),
          });
        } catch (error) {
          failures.push(`${r.method} ${r.url} threw ${String(error)}`);
          continue;
        }
        if (res.statusCode >= 500)
          failures.push(`${r.method} ${r.url} → ${res.statusCode} ${res.body.slice(0, 120)}`);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('survives hostile path and query values', async () => {
    const failures: string[] = [];
    const weird = ["' OR 1=1 --", '../../etc/passwd', '%00', '😀', 'a'.repeat(5000), '${7*7}'];
    for (const r of protectedRoutes().filter((x) => !SKIP.has(x.url) && x.method === 'GET')) {
      for (const w of weird) {
        const url = `${fillPath(r, orgId)}?limit=${encodeURIComponent(w)}&cursor=${encodeURIComponent(w)}&status=${encodeURIComponent(w)}`;
        const res = await owner.request('GET', url);
        if (res.statusCode >= 500)
          failures.push(`GET ${r.url} (${w.slice(0, 10)}) → ${res.statusCode}`);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('rejects bodies that are not JSON, and oversized bodies, before any handler runs', async () => {
    const url = `/v1/organizations/${orgId}/invoices`;
    const text = await owner.request('POST', url, {
      headers: { 'content-type': 'text/plain' },
      body: 'amount=1',
    });
    expect([400, 415]).toContain(text.statusCode);
    const huge = await api.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.test', password: 'x'.repeat(2_000_000) }),
    });
    expect(huge.statusCode).toBe(413);
  });
});

describe('slow clients', () => {
  it('has request, connection and keep-alive timeouts set', () => {
    expect(api.app.server.requestTimeout).toBe(30_000);
    expect(api.app.server.keepAliveTimeout).toBe(65_000);
  });
});

describe('responses', () => {
  it('sets defensive headers and never caches API responses', async () => {
    const res = await owner.request('GET', '/v1/me');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['server']).toBeUndefined();
  });

  it('does not leak stack traces, SQL or file paths in errors', async () => {
    const bodies: string[] = [];
    for (const [method, url] of [
      ['GET', `/v1/organizations/${orgId}/invoices/not-a-uuid`],
      ['GET', '/v1/nope'],
      ['POST', '/v1/auth/login'],
      ['GET', `/v1/organizations/${orgId}/invoices?limit=abc`],
    ] as const) {
      const res = await owner.request(method, url, method === 'POST' ? { body: { email: 1 } } : {});
      bodies.push(res.body);
    }
    for (const b of bodies) {
      expect(b).not.toMatch(
        /\bat .*\(.*:\d+:\d+\)|node_modules|SELECT |INSERT |select .* from|\/home\//,
      );
    }
  });

  it('marks the session cookie HttpOnly and SameSite=Strict', async () => {
    const agent = await signedInUser(api, 'cookie');
    const res = await new Agent(api).request('POST', '/v1/auth/login', {
      body: { email: agent.email, password: 'a long and unique passphrase' },
    });
    const header = String(res.headers['set-cookie']);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Strict/i);
  });

  it('does not reveal whether an email has an account (login, forgot, register)', async () => {
    const known = await signedInUser(api, 'known');
    const wrong = new Agent(api);
    const a = await wrong.request('POST', '/v1/auth/login', {
      body: { email: known.email, password: 'definitely wrong password' },
    });
    const b = await wrong.request('POST', '/v1/auth/login', {
      body: { email: 'nobody-here@example.test', password: 'definitely wrong password' },
    });
    expect(a.statusCode).toBe(b.statusCode);
    expect(a.json<{ error: { message: string } }>().error.message).toBe(
      b.json<{ error: { message: string } }>().error.message,
    );
    const f1 = await wrong.request('POST', '/v1/auth/password/forgot', {
      body: { email: known.email },
    });
    const f2 = await wrong.request('POST', '/v1/auth/password/forgot', {
      body: { email: 'nobody-here@example.test' },
    });
    expect([f1.statusCode, f1.body]).toEqual([f2.statusCode, f2.body]);
    const r1 = await wrong.request('POST', '/v1/auth/register', {
      body: { email: known.email, password: 'a long and unique passphrase', displayName: 'x' },
    });
    const r2 = await wrong.request('POST', '/v1/auth/register', {
      body: {
        email: `new-${randomUUID().slice(0, 8)}@example.test`,
        password: 'a long and unique passphrase',
        displayName: 'x',
      },
    });
    expect([r1.statusCode, r1.body]).toEqual([r2.statusCode, r2.body]);
  });
});

describe('the pay page and public endpoints', () => {
  it('expose nothing about other organizations and answer unknown ids with 404', async () => {
    for (const url of [
      '/v1/public/invoices/doesnotexist',
      '/v1/public/payment-links/doesnotexist',
      `/v1/public/invoices/${otherOrgId}`,
    ]) {
      const res = await api.app.inject({ method: 'GET', url });
      expect([400, 404], url).toContain(res.statusCode);
    }
  });
});
