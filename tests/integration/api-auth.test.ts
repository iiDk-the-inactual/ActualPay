import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Agent,
  createTestApi,
  PASSWORD,
  signedInUser,
  tokenFromEmail,
  totpCode,
  uniqueEmail,
  type TestApi,
} from './api-helpers';
import { resetDatabase } from './helpers';

let api: TestApi;

beforeAll(async () => {
  api = await createTestApi({ LOGIN_MAX_FAILURES: '3', LOGIN_LOCK_MINUTES: '15' });
  await resetDatabase(api.db);
});
afterAll(async () => {
  await api.close();
  await api.db.destroy();
});

const withoutRequestId = (body: { error: Record<string, unknown> }) => ({
  ...body.error,
  requestId: undefined,
});

describe('registration and verification', () => {
  it('responds identically for new and existing emails (no enumeration)', async () => {
    const email = uniqueEmail('enum');
    const agent = new Agent(api);
    const first = await agent.request('POST', '/v1/auth/register', {
      body: { email, password: PASSWORD, displayName: 'A' },
    });
    const second = await agent.request('POST', '/v1/auth/register', {
      body: { email, password: 'another long passphrase', displayName: 'B' },
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());
    // The difference is only visible to the mailbox owner.
    expect(api.mailer.lastTo(email)?.subject).toMatch(/Sign-up attempt/);
  });

  it('requires a verified email before sign-in', async () => {
    const email = uniqueEmail('verify');
    const agent = new Agent(api);
    await agent.request('POST', '/v1/auth/register', {
      body: { email, password: PASSWORD, displayName: 'V' },
    });
    const token = tokenFromEmail(api.mailer, email);
    expect((await agent.login(email)).json<{ error: { code: string } }>().error.code).toBe(
      'EMAIL_NOT_VERIFIED',
    );
    expect(
      (await agent.request('POST', '/v1/auth/verify-email', { body: { token } })).statusCode,
    ).toBe(200);
    // Single use.
    expect(
      (await agent.request('POST', '/v1/auth/verify-email', { body: { token } })).statusCode,
    ).toBe(400);
    expect((await agent.login(email)).statusCode).toBe(200);
  });

  it('rejects weak passwords with a validation error', async () => {
    const response = await new Agent(api).request('POST', '/v1/auth/register', {
      body: { email: uniqueEmail(), password: 'short', displayName: 'W' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('login', () => {
  it('sets a hardened session cookie and never returns secrets', async () => {
    const user = await signedInUser(api, 'cookie');
    const response = await new Agent(api).request('POST', '/v1/auth/login', {
      body: { email: user.email, password: PASSWORD },
    });
    const cookie = response.cookies.find((c) => c.name === 'ap_session');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(response.body).not.toMatch(/argon2|password_hash|passwordHash/);
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const user = await signedInUser(api, 'same');
    const unknown = await new Agent(api).request('POST', '/v1/auth/login', {
      body: { email: uniqueEmail('nobody'), password: PASSWORD },
    });
    const wrong = await new Agent(api).request('POST', '/v1/auth/login', {
      body: { email: user.email, password: 'definitely the wrong one' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(withoutRequestId(unknown.json())).toEqual(withoutRequestId(wrong.json()));
  });

  it('locks the account after repeated failures, even for the right password', async () => {
    const user = await signedInUser(api, 'lock');
    for (let i = 0; i < 3; i++) {
      await new Agent(api).request('POST', '/v1/auth/login', {
        body: { email: user.email, password: `wrong password number ${i}` },
      });
    }
    const locked = await new Agent(api).request('POST', '/v1/auth/login', {
      body: { email: user.email, password: PASSWORD },
    });
    expect(locked.statusCode).toBe(401);
    const failures = await api.db
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'user.login.failed')
      .where('actor_id', '=', user.userId!)
      .execute();
    expect(failures).toHaveLength(3);
  });

  it('rejects tampered and revoked session cookies', async () => {
    const user = await signedInUser(api, 'tamper');
    const tampered = new Agent(api);
    tampered.cookie = `${user.cookie ?? ''}x`;
    expect((await tampered.request('GET', '/v1/me')).statusCode).toBe(401);

    const csrf = user.csrf;
    const cookie = user.cookie;
    expect((await user.request('POST', '/v1/auth/logout')).statusCode).toBe(204);
    const replay = new Agent(api);
    replay.cookie = cookie;
    replay.csrf = csrf;
    expect((await replay.request('GET', '/v1/me')).statusCode).toBe(401);
  });
});

describe('CSRF', () => {
  it('requires the session-bound token on state-changing cookie requests', async () => {
    const user = await signedInUser(api, 'csrf');
    const missing = await user.request('POST', '/v1/organizations', {
      body: { name: 'X' },
      csrf: false,
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe('CSRF_FAILED');

    const other = await signedInUser(api, 'csrf-other');
    const foreign = await user.request('POST', '/v1/organizations', {
      body: { name: 'X' },
      csrf: false,
      headers: { 'x-csrf-token': other.csrf! },
    });
    expect(foreign.statusCode).toBe(403);

    expect(
      (await user.request('POST', '/v1/organizations', { body: { name: 'X' } })).statusCode,
    ).toBe(201);
  });
});

describe('password reset and change', () => {
  it('does not reveal whether an email exists', async () => {
    const before = api.mailer.sent.length;
    const response = await new Agent(api).request('POST', '/v1/auth/password/forgot', {
      body: { email: uniqueEmail('ghost') },
    });
    expect(response.statusCode).toBe(202);
    expect(api.mailer.sent.length).toBe(before);
  });

  it('resets once, revokes all sessions, and the token cannot be reused', async () => {
    const user = await signedInUser(api, 'reset');
    await new Agent(api).request('POST', '/v1/auth/password/forgot', {
      body: { email: user.email },
    });
    const token = tokenFromEmail(api.mailer, user.email);
    const newPassword = 'a brand new long passphrase';
    expect(
      (
        await new Agent(api).request('POST', '/v1/auth/password/reset', {
          body: { token, newPassword },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await new Agent(api).request('POST', '/v1/auth/password/reset', {
          body: { token, newPassword: 'yet another passphrase here' },
        })
      ).statusCode,
    ).toBe(400);
    expect((await user.request('GET', '/v1/me')).statusCode).toBe(401);
    expect((await new Agent(api).login(user.email, newPassword)).statusCode).toBe(200);
  });

  it('only the newest reset link works', async () => {
    const user = await signedInUser(api, 'newest');
    await new Agent(api).request('POST', '/v1/auth/password/forgot', {
      body: { email: user.email },
    });
    const older = tokenFromEmail(api.mailer, user.email);
    await new Agent(api).request('POST', '/v1/auth/password/forgot', {
      body: { email: user.email },
    });
    expect(
      (
        await new Agent(api).request('POST', '/v1/auth/password/reset', {
          body: { token: older, newPassword: 'some other passphrase' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('changing the password requires the current one and signs out other sessions', async () => {
    const user = await signedInUser(api, 'change');
    const second = new Agent(api);
    await second.login(user.email);
    const bad = await user.request('POST', '/v1/me/password', {
      body: { currentPassword: 'not my password!!', newPassword: 'a changed passphrase' },
    });
    expect(bad.statusCode).toBe(401);
    expect(
      (
        await user.request('POST', '/v1/me/password', {
          body: { currentPassword: PASSWORD, newPassword: 'a changed passphrase' },
        })
      ).statusCode,
    ).toBe(204);
    expect((await user.request('GET', '/v1/me')).statusCode).toBe(200);
    expect((await second.request('GET', '/v1/me')).statusCode).toBe(401);
  });
});

describe('two-factor authentication', () => {
  async function enroll(user: Agent): Promise<{ secret: string; recoveryCodes: string[] }> {
    const setup = await user.request('POST', '/v1/me/mfa/totp/setup');
    expect(setup.statusCode).toBe(200);
    const { secret, otpauthUri } = setup.json<{ secret: string; otpauthUri: string }>();
    expect(otpauthUri.startsWith('otpauth://totp/')).toBe(true);
    expect(
      (await user.request('POST', '/v1/me/mfa/totp/confirm', { body: { code: '000000' } }))
        .statusCode,
    ).toBe(400);
    const confirm = await user.request('POST', '/v1/me/mfa/totp/confirm', {
      body: { code: totpCode(secret) },
    });
    expect(confirm.statusCode).toBe(200);
    return { secret, recoveryCodes: confirm.json<{ recoveryCodes: string[] }>().recoveryCodes };
  }

  it('stores the TOTP seed encrypted, never in clear', async () => {
    const user = await signedInUser(api, 'seed');
    const { secret } = await enroll(user);
    const row = await api.db
      .selectFrom('totp_credentials')
      .select('secret_ciphertext')
      .where('user_id', '=', user.userId!)
      .executeTakeFirstOrThrow();
    expect(row.secret_ciphertext.startsWith('v1.')).toBe(true);
    expect(row.secret_ciphertext).not.toContain(secret);
  });

  it('requires the second factor at login and blocks code replay', async () => {
    const user = await signedInUser(api, 'mfa');
    const { secret } = await enroll(user);

    const agent = new Agent(api);
    const step1 = await agent.login(user.email);
    expect(step1.json<{ status: string }>().status).toBe('mfa_required');
    expect(agent.cookie).toBeUndefined();
    const { mfaToken } = step1.json<{ mfaToken: string }>();

    // The enrollment code's time step is used; a code from the next step works.
    const nextCode = totpCode(secret, 30_000);
    const ok = await agent.completeMfa(mfaToken, nextCode);
    expect(ok.statusCode).toBe(200);
    const me = await agent.request('GET', '/v1/me');
    expect(me.json<{ mfaVerified: boolean }>().mfaVerified).toBe(true);

    // Challenge is single-use, and the same code cannot be replayed on a new challenge.
    expect((await new Agent(api).completeMfa(mfaToken, nextCode)).statusCode).toBe(401);
    const again = await new Agent(api).login(user.email);
    expect(
      (await new Agent(api).completeMfa(again.json<{ mfaToken: string }>().mfaToken, nextCode))
        .statusCode,
    ).toBe(401);
  });

  it('burns a challenge after five wrong codes', async () => {
    const user = await signedInUser(api, 'burn');
    const { secret } = await enroll(user);
    const agent = new Agent(api);
    const { mfaToken } = (await agent.login(user.email)).json<{ mfaToken: string }>();
    for (let i = 0; i < 5; i++)
      expect((await agent.completeMfa(mfaToken, '111111')).statusCode).toBe(401);
    expect((await agent.completeMfa(mfaToken, totpCode(secret, 30_000))).statusCode).toBe(401);
  });

  it('accepts each recovery code exactly once', async () => {
    const user = await signedInUser(api, 'recovery');
    const { recoveryCodes } = await enroll(user);
    const code = recoveryCodes[0]!;
    const first = new Agent(api);
    expect(
      (
        await first.completeMfa(
          (await first.login(user.email)).json<{ mfaToken: string }>().mfaToken,
          code,
        )
      ).statusCode,
    ).toBe(200);
    const second = new Agent(api);
    expect(
      (
        await second.completeMfa(
          (await second.login(user.email)).json<{ mfaToken: string }>().mfaToken,
          code,
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (await first.request('GET', '/v1/me')).json<{ recoveryCodesRemaining: number }>()
        .recoveryCodesRemaining,
    ).toBe(9);
  });

  it('disabling requires password and a valid code', async () => {
    const user = await signedInUser(api, 'disable');
    const { secret } = await enroll(user);
    expect(
      (
        await user.request('POST', '/v1/me/mfa/totp/disable', {
          body: { password: 'wrong password!!', code: totpCode(secret, 30_000) },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await user.request('POST', '/v1/me/mfa/totp/disable', {
          body: { password: PASSWORD, code: '123456' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await user.request('POST', '/v1/me/mfa/totp/disable', {
          body: { password: PASSWORD, code: totpCode(secret, 30_000) },
        })
      ).statusCode,
    ).toBe(204);
    expect((await new Agent(api).login(user.email)).json<{ status: string }>().status).toBe(
      'authenticated',
    );
  });
});

describe('sessions', () => {
  it('lists own sessions and cannot revoke someone else\u2019s', async () => {
    const alice = await signedInUser(api, 'alice');
    const bob = await signedInUser(api, 'bob');
    const bobSessions = (await bob.request('GET', '/v1/me/sessions')).json<{
      data: { id: string; current: boolean }[];
    }>().data;
    const bobSessionId = bobSessions.find((s) => s.current)!.id;
    expect((await alice.request('DELETE', `/v1/me/sessions/${bobSessionId}`)).statusCode).toBe(404);
    expect((await bob.request('GET', '/v1/me')).statusCode).toBe(200);
  });

  it('expires idle sessions', async () => {
    const user = await signedInUser(api, 'idle');
    await sql`UPDATE sessions SET idle_expires_at = now() - interval '1 second' WHERE user_id = ${user.userId!}`.execute(
      api.db,
    );
    expect((await user.request('GET', '/v1/me')).statusCode).toBe(401);
  });
});
