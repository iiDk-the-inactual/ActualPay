/**
 * Rate limiting with and without Redis.
 *
 * TEST_REDIS_URL must point at a disposable logical database ending in /15
 * (it is flushed). Without it, the shared-counter tests are skipped and the
 * outage tests still run.
 */
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApi, PASSWORD, uniqueEmail, type TestApi } from './api-helpers';
import { createTestDb, resetDatabase } from './helpers';

const redisUrl = process.env['TEST_REDIS_URL'];
if (redisUrl && !redisUrl.endsWith('/15')) {
  throw new Error('TEST_REDIS_URL must select logical database 15 (it is flushed by these tests).');
}

const LIMIT = '3';
const login = (api: TestApi) =>
  api.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: uniqueEmail(), password: PASSWORD },
  });

async function statuses(apis: TestApi[], count: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push((await login(apis[i % apis.length]!)).statusCode);
  return out;
}

beforeAll(async () => {
  const db = createTestDb();
  await resetDatabase(db);
  await db.destroy();
});

describe('Redis unavailable', () => {
  let api: TestApi;
  let deadRedis: Redis;

  beforeAll(async () => {
    // Nothing listens on port 1: every Redis call fails immediately.
    deadRedis = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    deadRedis.on('error', () => undefined);
    api = await createTestApi({ RATE_LIMIT_AUTH_PER_MINUTE: LIMIT }, createTestDb(), deadRedis);
  });
  afterAll(async () => {
    await api.close();
    await api.db.destroy();
    deadRedis.disconnect();
  });

  it('still enforces the limit with per-instance counters', async () => {
    expect(await statuses([api], 5)).toEqual([401, 401, 401, 429, 429]);
  });

  it('keeps serving non-limited traffic', async () => {
    expect((await api.app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
  });
});

describe.skipIf(!redisUrl)('Redis available', () => {
  let a: TestApi;
  let b: TestApi;
  let redisA: Redis;
  let redisB: Redis;

  beforeAll(async () => {
    redisA = new Redis(redisUrl!, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    redisB = new Redis(redisUrl!, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    await Promise.all([redisA.connect(), redisB.connect()]);
    await redisA.flushdb();
    a = await createTestApi({ RATE_LIMIT_AUTH_PER_MINUTE: LIMIT }, createTestDb(), redisA);
    b = await createTestApi({ RATE_LIMIT_AUTH_PER_MINUTE: LIMIT }, createTestDb(), redisB);
  });
  afterAll(async () => {
    for (const api of [a, b]) {
      await api.close();
      await api.db.destroy();
    }
    redisA.disconnect();
    redisB.disconnect();
  });

  it('shares counters across API instances', async () => {
    // Alternate between two instances: the shared limit of 3 still applies.
    expect(await statuses([a, b], 5)).toEqual([401, 401, 401, 429, 429]);
    expect(await redisA.keys('actualpay-rl:*')).not.toHaveLength(0);
  });

  it('falls back when Redis drops mid-flight', async () => {
    await redisA.flushdb();
    redisA.disconnect(); // instance A loses Redis; B keeps it
    expect(await statuses([a], 5)).toEqual([401, 401, 401, 429, 429]);
  });
});
