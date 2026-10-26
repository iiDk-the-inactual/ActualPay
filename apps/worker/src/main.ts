/**
 * Worker process entry point: watches the chains and settles payments.
 *
 *   npm run worker:start   run forever (SIGTERM/SIGINT finish the current cycle)
 *   npm run worker:once    run one cycle and exit (useful for testing)
 *   npm run worker:status  print cursors, leases and open issues
 *
 * Several workers may run at once; leases make each task run in one place at a
 * time. Startup is fail-fast: bad configuration or an unreachable database
 * aborts before any work.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { SecretBox } from '@actualpay/auth';
import { createChainAdapters, createOutgoingNodes } from '@actualpay/chains';
import { describeConfig, loadConfig } from '@actualpay/config';
import { createDb } from '@actualpay/database';
import { DevLogMailer, SmtpMailer, type Mailer } from '@actualpay/email';
import { createLogger } from '@actualpay/shared';
import { listIssues, runCycle, startWorker } from '@actualpay/watcher';

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'start';
  const config = loadConfig();
  const logger = createLogger({ name: 'actualpay-worker', level: config.logLevel });
  const db = createDb({
    url: config.database.url,
    poolMax: config.database.poolMax,
    ssl: config.database.ssl,
    applicationName: 'actualpay-worker',
  });
  await sql`SELECT 1`.execute(db);

  if (mode === 'status') {
    const cursors = await db.selectFrom('chain_cursors').selectAll().execute();
    const leases = await db.selectFrom('job_leases').selectAll().orderBy('name').execute();
    const issues = await listIssues(db, { status: 'open' });
    process.stdout.write(`${JSON.stringify({ cursors, leases, openIssues: issues }, null, 2)}\n`);
    await db.destroy();
    return;
  }

  logger.info({ config: describeConfig(config), mode }, 'starting worker');

  // Account-model chains watch every deposit address we have ever issued,
  // including expired invoices and archived wallets: customers pay late.
  const adapters = createChainAdapters(config, {
    watchedAddresses: async (chain) => {
      const rows = await db
        .selectFrom('deposit_addresses')
        .select('address')
        .where('chain', '=', chain)
        .where('network', '=', config.network)
        .execute();
      return new Set(rows.map((r) => r.address.toLowerCase()));
    },
  });
  const mailer: Mailer = config.smtp
    ? new SmtpMailer(config.smtp)
    : new DevLogMailer(logger, config.env);
  const deps = {
    db,
    logger,
    adapters,
    ownerId: `worker-${randomUUID().slice(0, 8)}`,
    // Withdrawals (broadcast and confirmation tracking) only exist when the platform holds funds.
    ...(config.custody.mode === 'platform'
      ? { outgoing: createOutgoingNodes(config).byChain }
      : {}),
    notifications: {
      mailer,
      appName: config.appName,
      baseUrl: config.publicBaseUrl.toString(),
      ...(config.operatorAlertEmail ? { operatorEmail: config.operatorAlertEmail } : {}),
    },
    webhooks: {
      box: new SecretBox(config.secrets.encryptionKey, 'webhooks'),
      policy: config.webhooks,
    },
  };

  if (mode === 'once') {
    process.stdout.write(`${JSON.stringify(await runCycle(deps), null, 2)}\n`);
    await db.destroy();
    return;
  }

  const worker = startWorker({ ...deps, intervalMs: config.worker.scanIntervalSeconds * 1000 });
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    void worker
      .stop()
      .then(() => db.destroy())
      .then(() => process.exit(0));
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main().catch((error: unknown) => {
  console.error('Worker failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
