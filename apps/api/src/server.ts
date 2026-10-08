/**
 * API process entry point.
 *
 * Startup is fail-fast: invalid configuration or an unreachable database
 * aborts before the port opens. SIGTERM/SIGINT drain in-flight requests.
 */
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { describeConfig, loadConfig } from '@actualpay/config';
import { createDb } from '@actualpay/database';
import { DevLogMailer, SmtpMailer, type Mailer } from '@actualpay/email';
import { createLogger } from '@actualpay/shared';
import { buildApp } from './app';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ name: 'actualpay-api', level: config.logLevel });
  logger.info({ config: describeConfig(config) }, 'starting API');

  const db = createDb({
    url: config.database.url,
    poolMax: config.database.poolMax,
    ssl: config.database.ssl,
    applicationName: 'actualpay-api',
  });
  await sql`SELECT 1`.execute(db);

  const redis = new Redis(config.redis.url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  // ioredis emits an error on every reconnect attempt; log at most once a minute.
  let lastRedisWarning = 0;
  redis.on('error', (error: unknown) => {
    if (Date.now() - lastRedisWarning < 60_000) return;
    lastRedisWarning = Date.now();
    logger.warn(
      { err: error },
      'redis error (rate limiting uses per-instance counters until it recovers)',
    );
  });
  await redis.connect().catch((error: unknown) => {
    logger.warn({ err: error }, 'redis unavailable at startup');
  });

  const mailer: Mailer = config.smtp
    ? new SmtpMailer(config.smtp)
    : new DevLogMailer(logger, config.env);

  const { app } = await buildApp({ config, db, logger, mailer, redis });
  await app.listen({ host: config.api.host, port: config.api.port });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    await app.close();
    redis.disconnect();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // Configuration errors are already free of secret values.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
