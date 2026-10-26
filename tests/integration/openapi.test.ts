/** The OpenAPI document is generated from the routes, valid, complete and committed. */
import { readFileSync } from 'node:fs';
import SwaggerParser from '@apidevtools/swagger-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildOpenApi, routeRegistry } from '@actualpay/api';
import { createTestApi, type TestApi } from './api-helpers';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(async () => {
  await api.close();
  await api.db.destroy();
});

const committed = () =>
  JSON.parse(readFileSync(new URL('../../docs/openapi.json', import.meta.url), 'utf8')) as {
    paths: Record<string, Record<string, { operationId: string; security: unknown[] }>>;
  };

describe('OpenAPI', () => {
  it('is a valid OpenAPI document', async () => {
    const spec = buildOpenApi(routeRegistry, {
      title: 'T',
      version: '1',
      serverUrl: 'https://x.test',
    });
    await expect(SwaggerParser.validate(structuredClone(spec) as never)).resolves.toBeTruthy();
  });

  it('describes every registered route exactly once with unique operation ids', () => {
    const doc = committed();
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p));
    const unique = new Set(routeRegistry.map((r) => `${r.method} ${r.url}`));
    expect(ops).toHaveLength(unique.size);
    expect(new Set(ops.map((o) => o.operationId)).size).toBe(ops.length);
  });

  it('marks exactly the public routes as requiring no authentication', () => {
    const doc = committed();
    const open: string[] = [];
    for (const [path, methods] of Object.entries(doc.paths))
      for (const [method, op] of Object.entries(methods))
        if (op.security.length === 0) open.push(`${method.toUpperCase()} ${path}`);
    for (const route of open) {
      expect(route).toMatch(
        /\/v1\/(public\/|auth\/|health|ready|openapi|invitations|notification-)|\/v1\/notification|\/health|\/ready/,
      );
    }
    expect(open.some((r) => r.includes('/withdrawals'))).toBe(false);
    expect(open.some((r) => r.includes('/admin'))).toBe(false);
    expect(open.some((r) => r.includes('/api-keys'))).toBe(false);
  });

  it('does not let API keys change members, keys, admin settings, approvals, destinations or limits', () => {
    const doc = committed();
    const bearerRoutes = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(
          ([method, op]) => method !== 'get' && JSON.stringify(op.security).includes('bearerAuth'),
        )
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    );
    for (const r of bearerRoutes) {
      expect(r).not.toMatch(
        /\/admin\/|\/api-keys|\/members|\/approve|withdrawal-(destinations|policies)/,
      );
    }
  });

  it('is served by the API and matches what the registry produces', async () => {
    const res = await api.app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const served = res.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(served.openapi).toBe('3.0.3');
    expect(Object.keys(served.paths).sort()).toEqual(Object.keys(committed().paths).sort());
  });

  it('matches the committed docs/openapi.json (run npm run openapi:generate if this fails)', async () => {
    const served = await api.app.inject({ method: 'GET', url: '/v1/openapi.json' });
    const generated = served.json<{ paths: Record<string, unknown> }>().paths;
    // Same routes and same operations; the servers block differs by configuration.
    expect(JSON.stringify(Object.keys(generated).sort())).toBe(
      JSON.stringify(Object.keys(committed().paths).sort()),
    );
    for (const [path, methods] of Object.entries(committed().paths)) {
      expect(Object.keys(generated[path] as object).sort()).toEqual(Object.keys(methods).sort());
      for (const [method, op] of Object.entries(methods))
        expect(JSON.stringify((generated[path] as Record<string, unknown>)[method])).toBe(
          JSON.stringify(op),
        );
    }
  });
});
