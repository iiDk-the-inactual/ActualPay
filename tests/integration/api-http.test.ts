import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, createTestApi, PASSWORD, uniqueEmail, type TestApi } from './api-helpers';
import { createTestDb, resetDatabase } from './helpers';

let api: TestApi;

beforeAll(async () => {
  api = await createTestApi();
  await resetDatabase(api.db);
});
afterAll(async () => {
  await api.close();
  await api.db.destroy();
});

describe('HTTP hardening', () => {
  it('uses a consistent error envelope with a server-generated request id', async () => {
    const response = await api.app.inject({
      method: 'GET',
      url: '/v1/nope',
      headers: { 'x-request-id': 'attacker-chosen' },
    });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string; requestId: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toMatch(/^req_/);
    expect(response.headers['x-request-id']).toBe(body.error.requestId);
  });

  it('sets security headers and disables caching', async () => {
    const response = await api.app.inject({ method: 'GET', url: '/health/live' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(String(response.headers['content-security-policy'])).toContain("default-src 'none'");
  });

  it('rejects malformed JSON, non-JSON bodies and prototype pollution', async () => {
    const malformed = await api.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toMatch(/at .*\.js|stack/i);

    const form = await api.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(form.statusCode).toBe(415);

    const poisoned = await api.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email":"a@b.co","password":"x","__proto__":{"isAdmin":true}}',
    });
    expect(poisoned.statusCode).toBe(400);
    expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined();
  });

  it('rejects oversized bodies', async () => {
    const response = await api.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(200_000) }),
    });
    expect(response.statusCode).toBe(413);
  });

  it('reports validation issues by path without echoing values', async () => {
    const response = await new Agent(api).request('POST', '/v1/auth/register', {
      body: { email: 'x', password: 'secret-value-here', displayName: '' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('secret-value-here');
  });

  it('readiness reports database health', async () => {
    const response = await api.app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ready',
      checks: { database: 'ok', redis: 'not_configured' },
    });
  });
});

describe('rate limiting', () => {
  it('limits authentication attempts per IP', async () => {
    const limited = await createTestApi({ RATE_LIMIT_AUTH_PER_MINUTE: '3' }, createTestDb());
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await limited.app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email: uniqueEmail(), password: PASSWORD },
        });
        statuses.push(r.statusCode);
      }
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses.slice(3)).toEqual([429, 429]);
      const last = await limited.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: uniqueEmail(), password: PASSWORD },
      });
      expect(last.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
      await limited.db.destroy();
    }
  });
});
