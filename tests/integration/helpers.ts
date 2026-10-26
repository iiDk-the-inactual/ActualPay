/**
 * Integration-test database harness.
 *
 * Uses TEST_DATABASE_URL and refuses to run unless the database name ends in
 * `_test`, because resetDatabase() drops the whole schema.
 */
import { sql } from 'kysely';
import { createDb, migrateToLatest, type Db } from '@actualpay/database';

export function testDatabaseUrl(): string {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set. See TASKS.md (local test database).');
  }
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to use database "${name}": integration tests require a name ending in _test.`,
    );
  }
  return url;
}

export function createTestDb(): Db {
  return createDb({ url: testDatabaseUrl(), poolMax: 20, applicationName: 'actualpay-tests' });
}

/** Drop and recreate the public schema, then migrate from zero. */
export async function resetDatabase(db: Db): Promise<void> {
  await sql`DROP SCHEMA IF EXISTS public CASCADE`.execute(db);
  await sql`CREATE SCHEMA public`.execute(db);
  await migrateToLatest(db);
}

let orgCounter = 0;
export async function createOrganization(db: Db, name = 'Test Org'): Promise<string> {
  orgCounter += 1;
  const row = await db
    .insertInto('organizations')
    .values({ slug: `org-${Date.now().toString(36)}-${orgCounter}`, name })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Pretend a watcher has started scanning `chain` (invoices refuse to exist before that). */
export async function initChainCursor(
  db: Db,
  chain: 'bitcoin' | 'litecoin' | 'ethereum' | 'tron' | 'xrpl',
  network: 'mainnet' | 'testnet' = 'testnet',
  cursor = '0',
): Promise<void> {
  await db
    .insertInto('chain_cursors')
    .values({ chain, network, cursor })
    .onConflict((oc) => oc.columns(['chain', 'network']).doNothing())
    .execute();
}

/**
 * Poll until `fn` returns something truthy. Bitcoin Core hands mempool
 * transactions to wallets asynchronously, so a scan issued milliseconds after
 * `sendtoaddress` can legitimately miss it; the next scan sees it.
 */
export async function eventually<T>(
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 8_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('eventually: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

type Rpc = (method: string, params?: unknown[], wallet?: string) => Promise<unknown>;

/**
 * One persistent miner wallet shared by every regtest test file. Block rewards
 * halve every 150 blocks, so a fresh miner per file ran a long-lived regtest
 * node dry within a few runs; mining only when the shared wallet needs coins
 * makes a node last essentially forever. Files run one after another, so
 * sharing is safe.
 */
export async function sharedRegtestMiner(
  rpc: Rpc,
  requiredCoins: number,
): Promise<{ wallet: string; address: string }> {
  const wallet = 'ap_shared_miner';
  const loaded = (await rpc('listwallets')) as string[];
  if (!loaded.includes(wallet)) {
    try {
      await rpc('loadwallet', [wallet]);
    } catch {
      await rpc('createwallet', [wallet]);
    }
  }
  const address = (await rpc('getnewaddress', ['', 'bech32'], wallet)) as string;
  const balance = async () => Number(await rpc('getbalance', [], wallet));
  if ((await balance()) < requiredCoins) await rpc('generatetoaddress', [101, address]);
  if ((await balance()) < requiredCoins)
    throw new Error(
      'The regtest miner wallet has too little to fund these tests: restart bitcoind with a fresh datadir.',
    );
  return { wallet, address };
}
