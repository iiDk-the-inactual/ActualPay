/**
 * Optional browser smoke test of the dashboard and hosted checkout.
 *
 * Boots the API in this process against TEST_DATABASE_URL (it WIPES that test
 * database), then drives headless Chromium through sign-up, email verification,
 * sign-in, organization creation, invoice creation and the public pay page.
 *
 * Needs Playwright with a browser installed (not a project dependency):
 *   npx playwright install chromium   # or have it globally resolvable
 *   node --env-file=.env --import tsx scripts/web-smoke.mjs
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { buildApp } from '@actualpay/api';
import { loadConfig } from '@actualpay/config';
import { MemoryMailer } from '@actualpay/email';
import { createLogger } from '@actualpay/shared';
import { confirmWallet, createWallet } from '@actualpay/wallets';
import {
  createTestDb,
  initChainCursor,
  resetDatabase,
  testDatabaseUrl,
} from '../tests/integration/helpers';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  process.stdout.write(`ok  ${message}\n`);
}

const config = loadConfig({
  APP_ENV: 'test',
  PUBLIC_BASE_URL: BASE,
  DATABASE_URL: testDatabaseUrl(),
  SESSION_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  NETWORK_MODE: 'testnet',
  ENABLED_ASSETS: 'eth',
  ETHEREUM_RPC_URL: 'http://127.0.0.1:1',
  RATE_LIMIT_AUTH_PER_MINUTE: '10000',
});
const db = createTestDb();
await resetDatabase(db);
await initChainCursor(db, 'ethereum');
const mailer = new MemoryMailer();
const { app } = await buildApp({
  config,
  db,
  logger: createLogger({ name: 'smoke', level: 'silent' }),
  mailer,
  redis: null,
});
await app.listen({ port: PORT, host: '127.0.0.1' });

const browser = await chromium.launch();
const page = await browser.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  // The first /v1/me before sign-in is an expected 401.
  if (m.type() === 'error' && !m.text().includes('401')) problems.push(`console: ${m.text()}`);
});

try {
  const email = `smoke-${randomBytes(3).toString('hex')}@example.test`;
  await page.goto(`${BASE}/app/#/register`);
  await page.fill('input[name=displayName]', 'Smoke Tester');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', 'a long and unique passphrase');
  await page.click('button[type=submit]');
  await page.waitForSelector('.notice.ok');
  const token = /#token=([A-Za-z0-9_-]+)/.exec(mailer.lastTo(email)?.text ?? '')?.[1];
  check(token, 'verification email was sent');
  await page.goto(`${BASE}/app/#/verify?token=${token}`);
  await page.waitForSelector('text=Your email is verified');
  await page.goto(`${BASE}/app/#/login`);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', 'a long and unique passphrase');
  await page.click('button[type=submit]');
  await page.waitForSelector('text=You are not in an organization yet');
  check(true, 'signed in; no organization yet');
  await page.fill('input[name=name]', 'Smoke Shop');
  await page.click('button:has-text("Create organization")');
  await page.waitForSelector('text=Signed in to');
  check((await page.textContent('main')).includes('Smoke Shop'), 'organization created');

  const org = await db.selectFrom('organizations').select('id').executeTakeFirstOrThrow();
  const user = await db.selectFrom('users').select('id').executeTakeFirstOrThrow();
  const { wallet, firstAddress } = await createWallet(
    db,
    {
      organizationId: org.id,
      actor: { type: 'user', id: user.id },
      chain: 'ethereum',
      network: 'testnet',
      enabledChains: ['ethereum'],
      label: 'ETH',
      accountXpub: HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive("m/44'/60'/7'")
        .publicExtendedKey,
    },
    { requestId: 'smoke' },
  );
  await confirmWallet(
    db,
    {
      organizationId: org.id,
      walletId: wallet.id,
      actor: { type: 'user', id: user.id },
      address: firstAddress.address,
    },
    { requestId: 'smoke' },
  );

  await page.click('nav a:has-text("Invoices")');
  await page.waitForSelector('button:has-text("Create invoice")');
  await page.selectOption('select[name=asset]', 'eth');
  await page.fill('input[name=amount]', '0.01');
  await page.fill('input[name=description]', '<img src=x onerror=alert(1)> test');
  await page.click('button:has-text("Create invoice")');
  await page.waitForSelector('text=Customer link');
  const link = (await page.locator('td.mono', { hasText: '/pay/' }).first().textContent()) ?? '';
  check(link.includes('/pay/'), 'invoice created with a hosted link');
  check((await page.locator('img').count()) === 0, 'markup in a description is shown as text');

  for (const route of [
    'payments',
    'wallets',
    'webhooks',
    'withdrawals',
    'team',
    'keys',
    'audit',
    'security',
  ]) {
    await page.goto(`${BASE}/app/#/${route}`);
    await page.waitForSelector('main h1');
    await page.waitForLoadState('networkidle');
  }
  check(
    problems.length === 0,
    `every dashboard page renders without errors (${problems.join('; ')})`,
  );

  const pay = await browser.newPage();
  pay.on('pageerror', (e) => problems.push(`pay pageerror: ${e.message}`));
  await pay.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await pay.waitForSelector('text=Smoke Shop');
  check(true, 'pay page loads');
  check((await pay.textContent('main'))?.includes('0.01 ETH'), 'pay page shows the amount');
  check(
    (await pay.textContent('main'))?.toLowerCase().includes('0x'),
    'pay page shows a deposit address',
  );
  await page.click('button:has-text("Sign out")');
  await page.waitForSelector('text=Sign in');
  check(true, 'signed out');
  check(problems.length === 0, `no browser errors (${problems.join('; ')})`);
} finally {
  await browser.close();
  await app.close();
  await db.destroy();
}
