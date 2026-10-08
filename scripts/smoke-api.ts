/**
 * End-to-end smoke test against a *running* API (npm run api:dev).
 * Cross-platform replacement for long curl sequences.
 *
 *   SMOKE_EMAIL=you@example.com SMOKE_PASSWORD='...' npm run smoke:api
 *   npm run smoke:api -- --mfa          # also enrol TOTP with a real authenticator app
 *   npm run smoke:api -- --rate-limit   # also verify auth rate limiting
 *
 * Uses the account created by `npm run admin:create`. Never point this at
 * production: it creates organizations and API keys.
 */
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

const { values: flags } = parseArgs({
  options: { mfa: { type: 'boolean' }, 'rate-limit': { type: 'boolean' } },
});
const base = process.env['SMOKE_BASE_URL'] ?? 'http://127.0.0.1:3000';
const email = process.env['SMOKE_EMAIL'];
const password = process.env['SMOKE_PASSWORD'];
if (!email || !password) {
  console.error('Set SMOKE_EMAIL and SMOKE_PASSWORD (the account from npm run admin:create).');
  process.exit(2);
}

let cookie: string | undefined;
let csrf: string | undefined;
let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (cookie && !h['authorization']) h['cookie'] = cookie;
  if (csrf && method !== 'GET' && !h['authorization']) h['x-csrf-token'] = csrf;
  const response = await fetch(`${base}${path}`, {
    method,
    headers: h,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    const match = /(?:__Host-)?ap_session=([^;]*)/.exec(setCookie);
    if (match) cookie = match[1] ? match[0] : undefined;
  }
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* non-JSON */
  }
  return { status: response.status, json, headers: response.headers };
}

async function login(rl?: ReturnType<typeof createInterface>): Promise<boolean> {
  const r = await call('POST', '/v1/auth/login', { email, password });
  if (r.status === 200 && r.json['status'] === 'mfa_required') {
    if (!rl) return false;
    const code = await rl.question('Enter the CURRENT 6-digit code from your authenticator app: ');
    const m = await call('POST', '/v1/auth/login/mfa', { mfaToken: r.json['mfaToken'], code });
    if (m.status !== 200) return false;
    csrf = m.json['csrfToken'] as string;
    return true;
  }
  if (r.status !== 200) return false;
  csrf = r.json['csrfToken'] as string;
  return true;
}

async function main(): Promise<void> {
  const live = await call('GET', '/health/live');
  check('GET /health/live', live.status === 200);
  const ready = await call('GET', '/health/ready');
  check('GET /health/ready', ready.status === 200, JSON.stringify(ready.json['checks']));
  check('responses carry a request id', /^req_/.test(ready.headers.get('x-request-id') ?? ''));

  const rl = flags.mfa
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  check('login', await login(rl));
  const me = await call('GET', '/v1/me');
  check('GET /v1/me', me.status === 200 && typeof me.json['csrfToken'] === 'string');

  const noCsrf = await fetch(`${base}/v1/organizations`, {
    method: 'POST',
    headers: { cookie: cookie ?? '', 'content-type': 'application/json' },
    body: '{"name":"x"}',
  });
  check('state change without CSRF token is rejected', noCsrf.status === 403);

  const org = await call('POST', '/v1/organizations', {
    name: `Smoke ${new Date().toISOString()}`,
  });
  check('create organization', org.status === 201);
  const orgId = org.json['id'] as string;

  const key = await call(
    'POST',
    `/v1/organizations/${orgId}/api-keys`,
    { name: 'smoke', scopes: ['invoice:read'] },
    { 'idempotency-key': `smoke-${Date.now()}` },
  );
  check('create API key', key.status === 201);
  const apiKey = key.json['key'] as string;
  const keyId = key.json['id'] as string;

  const access = await call('GET', `/v1/organizations/${orgId}/access`, undefined, {
    authorization: `Bearer ${apiKey}`,
  });
  check(
    'API key authenticates with its scopes',
    access.status === 200 && JSON.stringify(access.json['permissions']) === '["invoice:read"]',
  );
  const sessionOnly = await call('GET', '/v1/me', undefined, { authorization: `Bearer ${apiKey}` });
  check('API key refused on session-only endpoint', sessionOnly.status === 403);

  const revoke = await call('DELETE', `/v1/organizations/${orgId}/api-keys/${keyId}`);
  check('revoke API key', revoke.status === 204);
  const afterRevoke = await call('GET', `/v1/organizations/${orgId}/access`, undefined, {
    authorization: `Bearer ${apiKey}`,
  });
  check('revoked key is rejected', afterRevoke.status === 401);

  const audit = await call('GET', `/v1/organizations/${orgId}/audit-log?limit=10`);
  const actions = ((audit.json['data'] as { action: string }[] | undefined) ?? []).map(
    (e) => e.action,
  );
  check(
    'audit log records key lifecycle',
    actions.includes('org.api_key.created') && actions.includes('org.api_key.revoked'),
  );

  if (flags.mfa && rl) {
    const status = await call('GET', '/v1/me');
    if (status.json['mfaEnabled'] === true) {
      console.log('MFA already enabled for this account; the login above already exercised it.');
    } else {
      const setup = await call('POST', '/v1/me/mfa/totp/setup');
      check('MFA setup', setup.status === 200);
      console.log(
        `\nAdd this to your authenticator app (manual entry):\n  secret: ${String(setup.json['secret'])}\n  uri:    ${String(setup.json['otpauthUri'])}\n`,
      );
      const code = await rl.question('Enter the 6-digit code shown by the app: ');
      const confirm = await call('POST', '/v1/me/mfa/totp/confirm', { code });
      check('MFA confirm', confirm.status === 200);
      console.log('Recovery codes (store them; shown once):', confirm.json['recoveryCodes']);
      console.log('\nWait for the code in your app to change (up to 30 s), then sign in again.');
      cookie = undefined;
      csrf = undefined;
      check('login with real authenticator code', await login(rl));
    }
    rl.close();
  }

  const logout = await call('POST', '/v1/auth/logout');
  check('logout', logout.status === 204);
  check('session invalid after logout', (await call('GET', '/v1/me')).status === 401);

  if (flags['rate-limit']) {
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++)
      statuses.push(
        (
          await call('POST', '/v1/auth/login', {
            email: `nobody-${i}@example.test`,
            password: 'not a real password',
          })
        ).status,
      );
    check('auth rate limit returns 429', statuses.includes(429), statuses.join(','));
  }

  console.log(
    failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} smoke check(s) FAILED.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error('Smoke test crashed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
