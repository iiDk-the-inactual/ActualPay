import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Agent,
  createOrg,
  createTestApi,
  signedInUser,
  tokenFromEmail,
  totpCode,
  type TestApi,
} from './api-helpers';
import { resetDatabase } from './helpers';

let api: TestApi;

beforeAll(async () => {
  api = await createTestApi();
  await resetDatabase(api.db);
});
afterAll(async () => {
  await api.close();
  await api.db.destroy();
});

type ErrorBody = { error: { code: string; message: string; requestId: string } };
const code = (r: LightMyRequestResponse) => r.json<ErrorBody>().error.code;

async function addMember(
  owner: Agent,
  orgId: string,
  role: string,
): Promise<Agent & { email: string }> {
  const member = await signedInUser(api, role);
  const invite = await owner.request('POST', `/v1/organizations/${orgId}/invitations`, {
    body: { email: member.email, role },
  });
  expect(invite.statusCode).toBe(201);
  const accept = await member.request('POST', '/v1/invitations/accept', {
    body: { token: tokenFromEmail(api.mailer, member.email) },
  });
  expect(accept.statusCode).toBe(200);
  return member;
}

async function mfaSession(user: Agent & { email: string }): Promise<Agent> {
  const { secret } = (await user.request('POST', '/v1/me/mfa/totp/setup')).json<{
    secret: string;
  }>();
  expect(
    (await user.request('POST', '/v1/me/mfa/totp/confirm', { body: { code: totpCode(secret) } }))
      .statusCode,
  ).toBe(200);
  return user; // confirming upgrades the current session to mfa-verified
}

describe('tenant isolation (IDOR/BOLA)', () => {
  it('hides other organizations entirely', async () => {
    const alice = await signedInUser(api, 'alice');
    const mallory = await signedInUser(api, 'mallory');
    const orgId = await createOrg(alice, 'Alice Co');

    for (const [method, path] of [
      ['GET', `/v1/organizations/${orgId}`],
      ['GET', `/v1/organizations/${orgId}/members`],
      ['GET', `/v1/organizations/${orgId}/api-keys`],
      ['GET', `/v1/organizations/${orgId}/audit-log`],
      ['PATCH', `/v1/organizations/${orgId}`],
    ] as const) {
      const response = await mallory.request(
        method,
        path,
        method === 'PATCH' ? { body: { name: 'pwned' } } : {},
      );
      expect(response.statusCode, `${method} ${path}`).toBe(404);
    }
    // Same answer as an organization that does not exist at all.
    expect(
      code(await mallory.request('GET', '/v1/organizations/00000000-0000-4000-8000-000000000000')),
    ).toBe('NOT_FOUND');
    expect((await mallory.request('GET', '/v1/organizations/not-a-uuid')).statusCode).toBe(404);
  });

  it('cannot accept an invitation addressed to someone else', async () => {
    const owner = await signedInUser(api, 'owner');
    const orgId = await createOrg(owner);
    const invitee = await signedInUser(api, 'invitee');
    const thief = await signedInUser(api, 'thief');
    await owner.request('POST', `/v1/organizations/${orgId}/invitations`, {
      body: { email: invitee.email, role: 'admin' },
    });
    const token = tokenFromEmail(api.mailer, invitee.email);
    expect(
      (await thief.request('POST', '/v1/invitations/accept', { body: { token } })).statusCode,
    ).toBe(400);
    expect((await thief.request('GET', `/v1/organizations/${orgId}`)).statusCode).toBe(404);
  });
});

describe('RBAC', () => {
  it('applies role permissions', async () => {
    const owner = await signedInUser(api, 'owner');
    const orgId = await createOrg(owner);
    const viewer = await addMember(owner, orgId, 'viewer');
    const developer = await addMember(owner, orgId, 'developer');

    expect((await viewer.request('GET', `/v1/organizations/${orgId}/members`)).statusCode).toBe(
      200,
    );
    expect(
      code(await viewer.request('PATCH', `/v1/organizations/${orgId}`, { body: { name: 'x' } })),
    ).toBe('FORBIDDEN');
    expect((await viewer.request('GET', `/v1/organizations/${orgId}/api-keys`)).statusCode).toBe(
      403,
    );
    expect((await viewer.request('GET', `/v1/organizations/${orgId}/audit-log`)).statusCode).toBe(
      403,
    );
    expect((await developer.request('GET', `/v1/organizations/${orgId}/api-keys`)).statusCode).toBe(
      200,
    );
    expect(
      (
        await developer.request('POST', `/v1/organizations/${orgId}/invitations`, {
          body: { email: 'x@example.test', role: 'viewer' },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('only owners can create, change or remove owners', async () => {
    const owner = await signedInUser(api, 'owner');
    const orgId = await createOrg(owner);
    const admin = await addMember(owner, orgId, 'admin');
    const viewer = await addMember(owner, orgId, 'viewer');

    expect(
      code(
        await admin.request('PATCH', `/v1/organizations/${orgId}/members/${viewer.userId!}`, {
          body: { role: 'owner' },
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      code(
        await admin.request('PATCH', `/v1/organizations/${orgId}/members/${admin.userId!}`, {
          body: { role: 'owner' },
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      code(await admin.request('DELETE', `/v1/organizations/${orgId}/members/${owner.userId!}`)),
    ).toBe('FORBIDDEN');
    expect(
      code(
        await admin.request('POST', `/v1/organizations/${orgId}/invitations`, {
          body: { email: 'boss@example.test', role: 'owner' },
        }),
      ),
    ).toBe('FORBIDDEN');
    // Admins can still manage non-owners.
    expect(
      (
        await admin.request('PATCH', `/v1/organizations/${orgId}/members/${viewer.userId!}`, {
          body: { role: 'finance' },
        })
      ).statusCode,
    ).toBe(204);
  });

  it('never leaves an organization without an owner', async () => {
    const owner = await signedInUser(api, 'owner');
    const orgId = await createOrg(owner);
    expect(
      code(await owner.request('DELETE', `/v1/organizations/${orgId}/members/${owner.userId!}`)),
    ).toBe('CONFLICT');
    expect(
      code(
        await owner.request('PATCH', `/v1/organizations/${orgId}/members/${owner.userId!}`, {
          body: { role: 'admin' },
        }),
      ),
    ).toBe('CONFLICT');

    const second = await addMember(owner, orgId, 'owner');
    expect(
      (await owner.request('DELETE', `/v1/organizations/${orgId}/members/${owner.userId!}`))
        .statusCode,
    ).toBe(204);
    expect((await second.request('GET', `/v1/organizations/${orgId}`)).statusCode).toBe(200);
    expect((await owner.request('GET', `/v1/organizations/${orgId}`)).statusCode).toBe(404);
  });

  it('read-only access when an organization is suspended', async () => {
    const owner = await signedInUser(api, 'owner');
    const orgId = await createOrg(owner);
    await api.db
      .updateTable('organizations')
      .set({ status: 'suspended' })
      .where('id', '=', orgId)
      .execute();
    expect((await owner.request('GET', `/v1/organizations/${orgId}`)).statusCode).toBe(200);
    expect(
      code(await owner.request('PATCH', `/v1/organizations/${orgId}`, { body: { name: 'x' } })),
    ).toBe('ORGANIZATION_SUSPENDED');
  });
});

describe('API keys', () => {
  async function createKey(
    agent: Agent,
    orgId: string,
    scopes: string[],
    headers: Record<string, string> = {},
  ) {
    return agent.request('POST', `/v1/organizations/${orgId}/api-keys`, {
      body: { name: 'integration', scopes },
      headers,
    });
  }

  it('shows the secret once and authenticates with exactly its scopes', async () => {
    const owner = await signedInUser(api, 'owner');
    const orgId = await createOrg(owner);
    const created = await createKey(owner, orgId, ['invoice:read', 'invoice:create']);
    expect(created.statusCode).toBe(201);
    const { key, id } = created.json<{ key: string; id: string }>();
    expect(key.startsWith('apk_test_')).toBe(true);

    const list = await owner.request('GET', `/v1/organizations/${orgId}/api-keys`);
    expect(list.body).not.toContain(key.split('_')[3]!);
    const stored = await api.db
      .selectFrom('api_keys')
      .select('secret_hash')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(stored.secret_hash).not.toContain(key.split('_')[3]!);

    const access = await api.app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/access`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(access.statusCode).toBe(200);
    expect(access.json()).toEqual({
      organizationId: orgId,
      via: 'api_key',
      role: null,
      permissions: ['invoice:create', 'invoice:read'],
    });
  });

  it('cannot be used outside its organization or on session-only endpoints', async () => {
    const owner = await signedInUser(api, 'owner');
    const orgA = await createOrg(owner, 'A');
    const orgB = await createOrg(owner, 'B');
    const { key } = (await createKey(owner, orgA, ['invoice:read'])).json<{ key: string }>();
    const auth = { authorization: `Bearer ${key}` };

    expect(
      (
        await api.app.inject({
          method: 'GET',
          url: `/v1/organizations/${orgB}/access`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await api.app.inject({
          method: 'GET',
          url: `/v1/organizations/${orgA}/api-keys`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(403);
    expect((await api.app.inject({ method: 'GET', url: '/v1/me', headers: auth })).statusCode).toBe(
      403,
    );
    expect(
      (
        await api.app.inject({
          method: 'POST',
          url: `/v1/organizations/${orgA}/api-keys`,
          headers: auth,
          payload: { name: 'x', scopes: ['invoice:read'] },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('rejects tampered, wrong-network and revoked keys identically', async () => {
    const owner = await signedInUser(api, 'owner');
    const orgId = await createOrg(owner);
    const { key, id } = (await createKey(owner, orgId, ['invoice:read'])).json<{
      key: string;
      id: string;
    }>();
    const call = (k: string) =>
      api.app.inject({
        method: 'GET',
        url: `/v1/organizations/${orgId}/access`,
        headers: { authorization: `Bearer ${k}` },
      });

    const tampered = key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A');
    const liveVariant = key.replace('apk_test_', 'apk_live_');
    expect((await call(tampered)).statusCode).toBe(401);
    expect((await call(liveVariant)).statusCode).toBe(401);
    expect((await call('apk_test_garbage')).statusCode).toBe(401);

    expect(
      (await owner.request('DELETE', `/v1/organizations/${orgId}/api-keys/${id}`)).statusCode,
    ).toBe(204);
    const revoked = await call(key);
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json<ErrorBody>().error.message).toBe(
      (await call(tampered)).json<ErrorBody>().error.message,
    );
  });

  it('rotation keeps the old key alive for the grace period only', async () => {
    const owner = await signedInUser(api, 'owner');
    const orgId = await createOrg(owner);
    const { key: oldKey, id } = (await createKey(owner, orgId, ['payment:read'])).json<{
      key: string;
      id: string;
    }>();
    const call = (k: string) =>
      api.app.inject({
        method: 'GET',
        url: `/v1/organizations/${orgId}/access`,
        headers: { authorization: `Bearer ${k}` },
      });

    const rotated = await owner.request(
      'POST',
      `/v1/organizations/${orgId}/api-keys/${id}/rotate`,
      { body: { graceHours: 1 } },
    );
    expect(rotated.statusCode).toBe(201);
    const { key: newKey, id: newId } = rotated.json<{ key: string; id: string }>();
    expect((await call(oldKey)).statusCode).toBe(200);
    expect((await call(newKey)).statusCode).toBe(200);

    expect(
      (
        await owner.request('POST', `/v1/organizations/${orgId}/api-keys/${newId}/rotate`, {
          body: { graceHours: 0 },
        })
      ).statusCode,
    ).toBe(201);
    expect((await call(newKey)).statusCode).toBe(401);
  });

  it('cannot grant scopes the creator lacks, and withdrawal keys need owner/admin with 2FA', async () => {
    const owner = await signedInUser(api, 'owner');
    const orgId = await createOrg(owner);
    const developer = await addMember(owner, orgId, 'developer');

    // Developers do not hold invoice:cancel, so they cannot delegate it.
    expect(code(await createKey(developer, orgId, ['invoice:cancel']))).toBe('FORBIDDEN');
    expect(code(await createKey(developer, orgId, ['withdrawal:create']))).toBe('FORBIDDEN');
    expect(code(await createKey(owner, orgId, ['withdrawal:create']))).toBe('MFA_REQUIRED');
    expect(code(await createKey(owner, orgId, ['member:manage']))).toBe('VALIDATION_FAILED');

    await mfaSession(owner);
    expect((await createKey(owner, orgId, ['withdrawal:create'])).statusCode).toBe(201);
  });
});

describe('idempotency', () => {
  it('replays the original response for a repeated key and rejects key reuse with a different body', async () => {
    const owner = await signedInUser(api, 'owner');
    const orgId = await createOrg(owner);
    const headers = { 'idempotency-key': 'create-key-001' };
    const body = { name: 'idem', scopes: ['invoice:read'] };

    const first = await owner.request('POST', `/v1/organizations/${orgId}/api-keys`, {
      body,
      headers,
    });
    const second = await owner.request('POST', `/v1/organizations/${orgId}/api-keys`, {
      body,
      headers,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);

    const keys = await api.db
      .selectFrom('api_keys')
      .select('id')
      .where('organization_id', '=', orgId)
      .execute();
    expect(keys).toHaveLength(1);

    const different = await owner.request('POST', `/v1/organizations/${orgId}/api-keys`, {
      body: { ...body, name: 'other' },
      headers,
    });
    expect(code(different)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('runs concurrent duplicates once', async () => {
    const owner = await signedInUser(api, 'owner');
    const orgId = await createOrg(owner);
    const headers = { 'idempotency-key': 'concurrent-1' };
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        owner.request('POST', `/v1/organizations/${orgId}/api-keys`, {
          body: { name: 'c', scopes: ['invoice:read'] },
          headers,
        }),
      ),
    );
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    const keys = await api.db
      .selectFrom('api_keys')
      .select('id')
      .where('organization_id', '=', orgId)
      .execute();
    expect(keys).toHaveLength(1);
  });

  it('stores validation failures too, and scopes keys per organization', async () => {
    const owner = await signedInUser(api, 'owner');
    const orgA = await createOrg(owner, 'A');
    const orgB = await createOrg(owner, 'B');
    const headers = { 'idempotency-key': 'shared-key' };
    const bad = await owner.request('POST', `/v1/organizations/${orgA}/api-keys`, {
      body: { name: 'x', scopes: ['withdrawal:create'] },
      headers,
    });
    expect(code(bad)).toBe('MFA_REQUIRED');
    expect(
      code(
        await owner.request('POST', `/v1/organizations/${orgA}/api-keys`, {
          body: { name: 'x', scopes: ['withdrawal:create'] },
          headers,
        }),
      ),
    ).toBe('MFA_REQUIRED');
    expect(
      (
        await owner.request('POST', `/v1/organizations/${orgB}/api-keys`, {
          body: { name: 'x', scopes: ['invoice:read'] },
          headers,
        })
      ).statusCode,
    ).toBe(201);
  });
});

describe('audit log', () => {
  it('records sensitive actions without secrets and paginates by cursor', async () => {
    const owner = await signedInUser(api, 'owner');
    const orgId = await createOrg(owner);
    for (let i = 0; i < 3; i++)
      await owner.request('POST', `/v1/organizations/${orgId}/api-keys`, {
        body: { name: `k${i}`, scopes: ['invoice:read'] },
      });

    const page1 = await owner.request('GET', `/v1/organizations/${orgId}/audit-log?limit=2`);
    const body1 = page1.json<{
      data: { action: string; requestId: string | null }[];
      nextCursor: string | null;
    }>();
    expect(body1.data).toHaveLength(2);
    expect(body1.data[0]!.requestId).toMatch(/^req_/);
    expect(body1.nextCursor).not.toBeNull();
    const page2 = await owner.request(
      'GET',
      `/v1/organizations/${orgId}/audit-log?limit=10&cursor=${body1.nextCursor!}`,
    );
    const actions = [...body1.data, ...page2.json<{ data: { action: string }[] }>().data].map(
      (e) => e.action,
    );
    expect(actions.filter((a) => a === 'org.api_key.created')).toHaveLength(3);
    expect(actions).toContain('org.created');
    expect(page2.body).not.toMatch(/apk_test_[A-Za-z0-9]{16}_/);

    expect(
      (await owner.request('GET', `/v1/organizations/${orgId}/audit-log?cursor=%%%`)).statusCode,
    ).toBe(400);
  });
});
