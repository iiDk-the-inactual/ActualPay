/**
 * HTTP test harness: a real Fastify app on the real test database, driven
 * through `app.inject` (no network), with an in-memory mailer.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Redis } from 'ioredis';
import { expect } from 'vitest';
import { Secret, TOTP } from 'otpauth';
import { buildApp } from '@actualpay/api';
import { loadConfig } from '@actualpay/config';
import { MemoryMailer } from '@actualpay/email';
import { createLogger } from '@actualpay/shared';
import type { Db } from '@actualpay/database';
import { createTestDb, testDatabaseUrl } from './helpers';

export interface TestApi {
  app: FastifyInstance;
  db: Db;
  mailer: MemoryMailer;
  close(): Promise<void>;
}

export async function createTestApi(
  env: Record<string, string> = {},
  db: Db = createTestDb(),
  redis: Redis | null = null,
): Promise<TestApi> {
  const config = loadConfig({
    APP_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DATABASE_URL: testDatabaseUrl(),
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    NETWORK_MODE: 'testnet',
    ENABLED_ASSETS: 'xrp',
    XRPL_WS_URL: 'wss://s.altnet.rippletest.net:51233',
    RATE_LIMIT_AUTH_PER_MINUTE: '10000',
    ...env,
  });
  const mailer = new MemoryMailer();
  const { app } = await buildApp({
    config,
    db,
    logger: createLogger({ name: 'test', level: 'silent' }),
    mailer,
    redis,
  });
  await app.ready();
  return { app, db, mailer, close: () => app.close() };
}

export function tokenFromEmail(mailer: MemoryMailer, to: string): string {
  const message = mailer.lastTo(to);
  const match = message ? /#token=([A-Za-z0-9_-]+)/.exec(message.text) : null;
  if (!match?.[1]) throw new Error(`No token email for ${to}`);
  return match[1];
}

let counter = 0;
export function uniqueEmail(label = 'user'): string {
  counter += 1;
  return `${label}-${Date.now().toString(36)}-${counter}@example.test`;
}

export const PASSWORD = 'a long and unique passphrase';

/** A cookie-jar client that also tracks the CSRF token. */
export class Agent {
  cookie: string | undefined;
  csrf: string | undefined;
  userId: string | undefined;

  constructor(readonly api: TestApi) {}

  async request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    options: { body?: unknown; headers?: Record<string, string>; csrf?: boolean } = {},
  ): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { ...options.headers };
    if (this.cookie) headers['cookie'] = this.cookie;
    if (this.csrf && options.csrf !== false && method !== 'GET')
      headers['x-csrf-token'] = this.csrf;
    const response = await this.api.app.inject({
      method,
      url,
      headers,
      ...(options.body !== undefined ? { payload: options.body as Record<string, unknown> } : {}),
    });
    const setCookie = response.cookies.find((c) => c.name === 'ap_session');
    if (setCookie) this.cookie = setCookie.value ? `ap_session=${setCookie.value}` : undefined;
    return response;
  }

  async login(email: string, password = PASSWORD): Promise<LightMyRequestResponse> {
    const response = await this.request('POST', '/v1/auth/login', { body: { email, password } });
    if (
      response.statusCode === 200 &&
      response.json<{ status: string }>().status === 'authenticated'
    ) {
      const body = response.json<{ csrfToken: string; user: { id: string } }>();
      this.csrf = body.csrfToken;
      this.userId = body.user.id;
    }
    return response;
  }

  async completeMfa(mfaToken: string, code: string): Promise<LightMyRequestResponse> {
    const response = await this.request('POST', '/v1/auth/login/mfa', { body: { mfaToken, code } });
    if (response.statusCode === 200) {
      const body = response.json<{ csrfToken: string; user: { id: string } }>();
      this.csrf = body.csrfToken;
      this.userId = body.user.id;
    }
    return response;
  }
}

/** Register, verify and sign in a fresh user. */
export async function signedInUser(
  api: TestApi,
  label = 'user',
): Promise<Agent & { email: string }> {
  const email = uniqueEmail(label);
  const agent = new Agent(api);
  const reg = await agent.request('POST', '/v1/auth/register', {
    body: { email, password: PASSWORD, displayName: label },
  });
  expect(reg.statusCode).toBe(202);
  const verify = await agent.request('POST', '/v1/auth/verify-email', {
    body: { token: tokenFromEmail(api.mailer, email) },
  });
  expect(verify.statusCode).toBe(200);
  const login = await agent.login(email);
  expect(login.statusCode).toBe(200);
  return Object.assign(agent, { email });
}

export function totpCode(secret: string, offsetMs = 0): string {
  return new TOTP({
    secret: Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  }).generate({ timestamp: Date.now() + offsetMs });
}

export async function createOrg(agent: Agent, name = 'Acme'): Promise<string> {
  const response = await agent.request('POST', '/v1/organizations', { body: { name } });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}
