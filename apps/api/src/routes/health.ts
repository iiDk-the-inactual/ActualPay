/**
 * Liveness: the process is up. Readiness: dependencies are reachable.
 * Neither reveals versions, configuration or error details.
 */
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { sql } from 'kysely';
import type { ApiContext } from '../http/context';

export function registerHealthRoutes(
  app: FastifyInstance,
  ctx: ApiContext,
  redis: Redis | null,
): void {
  app.get('/health/live', { config: { rateLimit: false } }, () => ({ status: 'ok' }));

  app.get('/health/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    const checks: Record<string, 'ok' | 'fail' | 'not_configured'> = {
      database: 'fail',
      redis: redis ? 'fail' : 'not_configured',
    };
    try {
      await sql`SELECT 1`.execute(ctx.db);
      checks['database'] = 'ok';
    } catch (error) {
      ctx.logger.error({ err: error }, 'readiness: database check failed');
    }
    if (redis) {
      try {
        await redis.ping();
        checks['redis'] = 'ok';
      } catch (error) {
        ctx.logger.error({ err: error }, 'readiness: redis check failed');
      }
    }
    // Redis only backs shared rate-limit counters (with a local fallback), so it does not gate readiness.
    const ready = checks['database'] === 'ok';
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });
}
