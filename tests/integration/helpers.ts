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
