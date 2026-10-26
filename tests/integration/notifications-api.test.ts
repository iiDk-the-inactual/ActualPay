/** Notification settings over HTTP: own preferences, MFA-protected forwarding, public confirmation. */
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

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
  await resetDatabase(api.db);
});
afterAll(async () => {
  await api.close();
  await api.db.destroy();
});

async function setup() {
  const plain = await signedInUser(api, 'notif');
  const orgId = await createOrg(plain, 'Notif Org');
  return { plain, orgId, mfa: await withMfa(api, plain), base: `/v1/organizations/${orgId}` };
}

describe('notification preferences', () => {
  it('lists defaults, changes only the caller’s own setting', async () => {
    const { plain, base } = await setup();
    const before = await plain.request('GET', `${base}/notifications`);
    expect(before.statusCode).toBe(200);
    const prefs = before.json<{
      preferences: { kind: string; enabled: boolean; isDefault: boolean }[];
    }>().preferences;
    expect(prefs.find((p) => p.kind === 'payments')).toMatchObject({
      enabled: false,
      isDefault: true,
    });
    expect(prefs.find((p) => p.kind === 'withdrawals')).toMatchObject({ enabled: true });

    const put = await plain.request('PUT', `${base}/notifications/preferences/payments`, {
      body: { enabled: true },
    });
    expect(put.statusCode).toBe(200);
    const after = await plain.request('GET', `${base}/notifications`);
    expect(
      after
        .json<{ preferences: { kind: string; enabled: boolean }[] }>()
        .preferences.find((p) => p.kind === 'payments')?.enabled,
    ).toBe(true);
  });

  it('rejects unknown kinds and strangers', async () => {
    const { plain, base } = await setup();
    expect(
      (
        await plain.request('PUT', `${base}/notifications/preferences/spam`, {
          body: { enabled: true },
        })
      ).statusCode,
    ).toBe(400);
    const stranger = await signedInUser(api, 'stranger');
    expect((await stranger.request('GET', `${base}/notifications`)).statusCode).toBe(404);
    expect((await new Agent(api).request('GET', `${base}/notifications`)).statusCode).toBe(401);
  });
});

describe('forwarding', () => {
  it('needs MFA, emails the address, and activates only after confirmation', async () => {
    const { mfa, base } = await setup();
    const lone = await signedInUser(api, 'nomfa');
    const loneOrg = await createOrg(lone, 'No MFA Org');
    const noMfa = await lone.request('POST', `/v1/organizations/${loneOrg}/notification-forwards`, {
      body: { email: 'books@example.test', kinds: ['withdrawals'] },
    });
    expect(noMfa.statusCode).toBe(403);
    expect(noMfa.json<{ error: { code: string } }>().error.code).toBe('MFA_REQUIRED');

    const created = await mfa.request('POST', `${base}/notification-forwards`, {
      body: { email: 'Books@Example.test', kinds: ['withdrawals'] },
    });
    expect(created.statusCode).toBe(202);
    const mail = api.mailer.lastTo('books@example.test');
    expect(mail?.subject).toContain('Confirm notification forwarding');
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail?.text ?? '')?.[1];
    expect(token).toBeTruthy();

    const listed = await mfa.request('GET', `${base}/notifications`);
    expect(listed.json<{ forwards: { status: string }[] }>().forwards[0]?.status).toBe('pending');

    const confirm = await new Agent(api).request('POST', '/v1/notification-forwards/confirm', {
      body: { token },
    });
    expect(confirm.statusCode).toBe(200);
    expect(
      (await mfa.request('GET', `${base}/notifications`)).json<{ forwards: { status: string }[] }>()
        .forwards[0]?.status,
    ).toBe('active');
    const again = await new Agent(api).request('POST', '/v1/notification-forwards/confirm', {
      body: { token },
    });
    expect(again.statusCode).toBe(400);
  });

  it('is limited to people who can manage settings, and removable', async () => {
    const { mfa, base } = await setup();
    const viewer = await signedInUser(api, 'viewer');
    const { orgId } = { orgId: base.split('/').pop()! };
    await api.db
      .insertInto('organization_members')
      .values({ organization_id: orgId, user_id: viewer.userId!, role: 'viewer' })
      .execute();
    const denied = await withMfa(api, viewer).then((v) =>
      v.request('POST', `${base}/notification-forwards`, {
        body: { email: 'x@example.test', kinds: ['security'] },
      }),
    );
    expect(denied.statusCode).toBe(403);

    const created = await mfa.request('POST', `${base}/notification-forwards`, {
      body: { email: 'y@example.test', kinds: ['security'] },
    });
    const id = created.json<{ id: string }>().id;
    expect((await mfa.request('DELETE', `${base}/notification-forwards/${id}`)).statusCode).toBe(
      204,
    );
    expect((await mfa.request('DELETE', `${base}/notification-forwards/${id}`)).statusCode).toBe(
      404,
    );
  });

  it('refuses malformed input without sending mail', async () => {
    const { mfa, base } = await setup();
    const sentBefore = api.mailer.sent.length;
    for (const body of [
      { email: 'nope', kinds: ['security'] },
      { email: 'a@example.test', kinds: [] },
      { email: 'a@example.test', kinds: ['bogus'] },
      { email: 'a@example.test', kinds: ['security'], extra: 1 },
    ])
      expect(
        (await mfa.request('POST', `${base}/notification-forwards`, { body })).statusCode,
      ).toBe(400);
    expect(api.mailer.sent.length).toBe(sentBefore);
  });
});
