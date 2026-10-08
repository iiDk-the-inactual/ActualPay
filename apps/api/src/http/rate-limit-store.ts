/**
 * Rate-limit store that degrades instead of disappearing.
 *
 * Normally counters live in Redis/Valkey so every API instance shares them.
 * If Redis is unreachable, each call falls back to an in-process counter.
 * Limits then apply per instance (N instances ≈ N× the configured limit)
 * rather than vanishing, so credential-stuffing and password-spraying
 * protection survives a Redis outage. When Redis recovers, shared counting
 * resumes automatically (fallback counters are not merged back; worst case a
 * client gets one extra window's worth of requests during the transition).
 *
 * The Redis and local implementations are the plugin's own, reused unchanged.
 */
import { createRequire } from 'node:module';
import type { FastifyRateLimitStore } from '@fastify/rate-limit';
import type { Redis } from 'ioredis';
import type { Logger } from '@actualpay/shared';

type IncrCallback = (error: Error | null, result?: { current: number; ttl: number }) => void;
type ChildOptions = Parameters<FastifyRateLimitStore['child']>[0];

interface PluginStore {
  incr(key: string, cb: IncrCallback, timeWindow: number, max: number): void;
  child(options: ChildOptions): PluginStore;
}

interface GlobalParams {
  continueExceeding?: boolean;
  exponentialBackoff?: boolean;
}

const require = createRequire(import.meta.url);
// The plugin has no "exports" map, so its bundled stores are importable by path.
const RedisStore = require('@fastify/rate-limit/store/RedisStore.js') as new (
  continueExceeding: boolean | undefined,
  exponentialBackoff: boolean | undefined,
  redis: Redis,
  key: string,
) => PluginStore;
const LocalStore = require('@fastify/rate-limit/store/LocalStore.js') as new (
  continueExceeding: boolean | undefined,
  exponentialBackoff: boolean | undefined,
  cache?: number,
) => PluginStore;

const WARN_INTERVAL_MS = 60_000;

class ResilientStore implements FastifyRateLimitStore {
  constructor(
    private readonly redis: Redis,
    private readonly primary: PluginStore,
    private readonly fallback: PluginStore,
    private readonly onFallback: (error: unknown) => void,
  ) {}

  incr(key: string, callback: IncrCallback, timeWindow: number, max: number): void {
    // Don't wait on a connection we already know is down.
    if (this.redis.status !== 'ready') {
      this.onFallback(new Error(`redis status: ${this.redis.status}`));
      this.fallback.incr(key, callback, timeWindow, max);
      return;
    }
    this.primary.incr(
      key,
      (error, result) => {
        if (error) {
          this.onFallback(error);
          this.fallback.incr(key, callback, timeWindow, max);
          return;
        }
        callback(null, result);
      },
      timeWindow,
      max,
    );
  }

  child(options: ChildOptions): ResilientStore {
    return new ResilientStore(
      this.redis,
      this.primary.child(options),
      this.fallback.child(options),
      this.onFallback,
    );
  }
}

/** Build a store constructor for `@fastify/rate-limit`'s `store` option. */
export function resilientStore(redis: Redis, logger: Logger, nameSpace: string) {
  let lastWarn = 0;
  const onFallback = (error: unknown) => {
    const now = Date.now();
    if (now - lastWarn < WARN_INTERVAL_MS) return;
    lastWarn = now;
    logger.warn({ err: error }, 'rate limiting is using per-instance counters (redis unavailable)');
  };
  return class extends ResilientStore {
    constructor(params: GlobalParams) {
      super(
        redis,
        new RedisStore(params.continueExceeding, params.exponentialBackoff, redis, nameSpace),
        new LocalStore(params.continueExceeding, params.exponentialBackoff),
        onFallback,
      );
    }
  };
}
