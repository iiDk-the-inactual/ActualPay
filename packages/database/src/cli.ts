#!/usr/bin/env node
/**
 * Database CLI. Needs only DATABASE_URL (or DATABASE_URL_FILE) so that
 * migrations can run before chain RPC and other services are configured.
 *
 *   migrate   apply pending migrations, then sync the asset registry
 *   status    list applied and pending migrations
 *
 * There is deliberately no "down" command: rolling back migrations on a
 * database holding financial records is a restore-from-backup decision.
 */
import { resolveFileSecrets } from '@actualpay/config';
import { createDb } from './client';
import { createMigrator, migrateToLatest } from './migrate';

async function main(): Promise<number> {
  const command = process.argv[2];
  let env: Record<string, string>;
  try {
    env = resolveFileSecrets(process.env, ['DATABASE_URL', 'DATABASE_SSL']);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 2;
  }
  const url = env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL (or DATABASE_URL_FILE) is required.');
    return 2;
  }
  const db = createDb({
    url,
    poolMax: 2,
    ssl: env['DATABASE_SSL'] === 'true',
    applicationName: 'actualpay-cli',
  });
  try {
    switch (command) {
      case 'migrate': {
        const result = await migrateToLatest(db);
        const applied = result.results ?? [];
        if (applied.length === 0) console.log('Database is up to date.');
        for (const r of applied)
          console.log(`${r.status === 'Success' ? 'applied' : r.status}: ${r.migrationName}`);
        console.log('Asset registry verified.');
        return 0;
      }
      case 'status': {
        const list = await createMigrator(db).getMigrations();
        for (const m of list) console.log(`${m.executedAt ? 'applied ' : 'PENDING '} ${m.name}`);
        return list.some((m) => !m.executedAt) ? 1 : 0;
      }
      default:
        console.error('Usage: cli.ts <migrate|status>');
        return 2;
    }
  } catch (error) {
    // Messages from pg do not contain the password; the URL is never printed.
    console.error('Database command failed:', error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await db.destroy();
  }
}

process.exitCode = await main();
