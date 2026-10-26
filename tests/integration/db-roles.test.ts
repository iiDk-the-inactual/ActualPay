/**
 * grantAppRole: the application role works, and cannot do what a
 * compromised application must not be able to do through SQL.
 *
 * Needs a test-database user allowed to create roles (a superuser, as in the
 * docker-compose and CI setups).
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, grantAppRole, type Db } from '@actualpay/database';
import { MemoryMailer } from '@actualpay/email';
import { createLogger } from '@actualpay/shared';
import { runCycle } from '@actualpay/watcher';
import { createTestApi, signedInUser, type TestApi } from './api-helpers';
import { createTestDb, resetDatabase, testDatabaseUrl } from './helpers';

const ROLE = 'actualpay_app';
let owner: Db;
let appDb: Db;
let api: TestApi;

beforeAll(async () => {
  owner = createTestDb();
  await resetDatabase(owner);
  const password = randomBytes(16).toString('hex');
  await sql
    .raw(`DROP OWNED BY ${ROLE}`)
    .execute(owner)
    .catch(() => undefined);
  await sql.raw(`DROP ROLE IF EXISTS ${ROLE}`).execute(owner);
  await sql
    .raw(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`)
    .execute(owner);
  await grantAppRole(owner, ROLE);
  await grantAppRole(owner, ROLE); // repeatable

  const url = new URL(testDatabaseUrl());
  url.username = ROLE;
  url.password = password;
  appDb = createDb({ url: url.toString(), poolMax: 5, applicationName: 'role-test' });
  api = await createTestApi({ DATABASE_URL: url.toString() }, appDb);
});
afterAll(async () => {
  await api.close();
  await appDb.destroy();
  await resetDatabase(owner); // drops the schema, and with it the role's table privileges
  await sql.raw(`DROP OWNED BY ${ROLE}`).execute(owner);
  await sql.raw(`DROP ROLE IF EXISTS ${ROLE}`).execute(owner);
  await owner.destroy();
});

describe('the application role', () => {
  it('can run the application: sign up, verify, sign in, create an organization', async () => {
    const user = await signedInUser(api, 'roletest');
    const org = await user.request('POST', '/v1/organizations', { body: { name: 'Role Org' } });
    expect(org.statusCode).toBe(201);
  });

  it('can run a full worker cycle (leases, reconciliation, notifications, webhooks)', async () => {
    const result = await runCycle({
      db: appDb,
      logger: createLogger({ name: 'test', level: 'silent' }),
      adapters: new Map(),
      notifications: {
        mailer: new MemoryMailer(),
        appName: 'ActualPay',
        baseUrl: 'https://x.test',
      },
    });
    expect(result.notifications).not.toHaveProperty('kind', 'lease_held');
    expect(result.reconciled).toBeDefined();
  });

  it('cannot change the schema', async () => {
    await expect(sql`CREATE TABLE evil (id int)`.execute(appDb)).rejects.toThrow(
      /permission denied/,
    );
    await expect(sql`ALTER TABLE ledger_entries ADD COLUMN x int`.execute(appDb)).rejects.toThrow();
    await expect(sql`DROP TABLE audit_log`.execute(appDb)).rejects.toThrow();
  });

  it('cannot switch off the guard triggers or truncate history', async () => {
    await expect(
      sql`ALTER TABLE ledger_entries DISABLE TRIGGER ALL`.execute(appDb),
    ).rejects.toThrow(/must be owner|permission denied/);
    await expect(sql`TRUNCATE ledger_entries CASCADE`.execute(appDb)).rejects.toThrow(
      /permission denied/,
    );
    await expect(sql`TRUNCATE audit_log CASCADE`.execute(appDb)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      sql`DROP TRIGGER ledger_entries_immutable ON ledger_entries`.execute(appDb),
    ).rejects.toThrow();
  });

  it('cannot delete ledger, audit or domain-event rows', async () => {
    for (const table of [
      'ledger_entries',
      'ledger_journals',
      'audit_log',
      'domain_events',
      'withdrawals',
    ])
      await expect(sql.raw(`DELETE FROM ${table}`).execute(appDb), table).rejects.toThrow(
        /permission denied/,
      );
  });

  it('cannot create roles, read other databases’ catalogs as an owner, or become the owner', async () => {
    await expect(sql`CREATE ROLE sneaky LOGIN`.execute(appDb)).rejects.toThrow();
    await expect(sql`SET ROLE actualpay`.execute(appDb)).rejects.toThrow();
  });
});
