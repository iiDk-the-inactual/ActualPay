/**
 * Writes docs/openapi.json from the route registry.
 *   npm run openapi:generate          write the file
 *   npm run openapi:generate -- --check   fail if the file is out of date
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { buildApp, buildOpenApi, routeRegistry } from '@actualpay/api';
import { loadConfig } from '@actualpay/config';
import { MemoryMailer } from '@actualpay/email';
import { createDb } from '@actualpay/database';
import { createLogger } from '@actualpay/shared';

const config = loadConfig({
  APP_ENV: 'test',
  PUBLIC_BASE_URL: 'https://pay.example.com',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/never_connected',
  SESSION_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  NETWORK_MODE: 'testnet',
  // Every optional route group is registered regardless of settings; the spec is the same.
  ENABLED_ASSETS: 'xrp',
  XRPL_WS_URL: 'wss://s.altnet.rippletest.net:51233',
});
const db = createDb({ url: config.database.url, poolMax: 1, applicationName: 'openapi' });
const { app } = await buildApp({
  config,
  db,
  logger: createLogger({ name: 'openapi', level: 'silent' }),
  mailer: new MemoryMailer(),
  redis: null,
});
const spec = `${JSON.stringify(
  buildOpenApi(routeRegistry, {
    title: 'ActualPay API',
    version: '1.0.0',
    serverUrl: 'https://pay.example.com',
  }),
  null,
  2,
)}\n`;
await app.close();
await db.destroy();

const target = new URL('../docs/openapi.json', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== spec) {
    process.stderr.write('docs/openapi.json is out of date: run npm run openapi:generate\n');
    process.exit(1);
  }
  process.stdout.write('docs/openapi.json is up to date\n');
} else {
  writeFileSync(target, spec);
  process.stdout.write(`wrote docs/openapi.json (${spec.length} bytes)\n`);
}
