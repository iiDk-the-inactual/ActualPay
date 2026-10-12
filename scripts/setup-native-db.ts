/**
 * Creates the development and test databases on a PostgreSQL server you
 * installed yourself (no Docker). Idempotent: existing roles and databases
 * are left alone.
 *
 *   ADMIN_DATABASE_URL=postgres://postgres:secret@localhost:5432/postgres \
 *     npm run db:setup-native
 *
 * The role, password and database names come from DATABASE_URL and
 * TEST_DATABASE_URL in .env. The admin URL is used only by this script and is
 * never written anywhere.
 */
import pg from 'pg';

function parse(name: string): { user: string; password: string; database: string } {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not set (copy .env.example to .env first).`);
  const url = new URL(raw);
  const database = url.pathname.replace(/^\//, '');
  if (!url.username || !url.password || !database) {
    throw new Error(`${name} must include a user, password and database name.`);
  }
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

/** Builds a statement with the server's own quoting (%I identifier, %L literal), then runs it. */
async function execFormatted(
  client: pg.Client,
  template: string,
  ...args: string[]
): Promise<void> {
  const built = await client.query<{ s: string }>(
    'SELECT format($1::text, VARIADIC $2::text[]) AS s',
    [template, args],
  );
  const statement = built.rows[0]?.s;
  if (!statement) throw new Error('could not build statement');
  await client.query(statement);
}

async function main(): Promise<number> {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) {
    console.error(
      'Set ADMIN_DATABASE_URL to a PostgreSQL superuser, e.g.\n' +
        '  postgres://postgres:<password>@localhost:5432/postgres',
    );
    return 2;
  }
  const dev = parse('DATABASE_URL');
  const test = parse('TEST_DATABASE_URL');
  if (!test.database.endsWith('_test')) {
    console.error('TEST_DATABASE_URL must point at a database whose name ends in _test.');
    return 2;
  }
  if (dev.user !== test.user) {
    console.error('DATABASE_URL and TEST_DATABASE_URL must use the same role.');
    return 2;
  }

  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const role = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [dev.user]);
    if (role.rowCount === 0) {
      await execFormatted(client, 'CREATE ROLE %I LOGIN PASSWORD %L', dev.user, dev.password);
      console.log(`created role: ${dev.user}`);
    } else {
      console.log(`role exists: ${dev.user} (password not changed)`);
    }
    for (const database of [dev.database, test.database]) {
      const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
      if (exists.rowCount === 0) {
        await execFormatted(client, 'CREATE DATABASE %I OWNER %I', database, dev.user);
        console.log(`created database: ${database}`);
      } else {
        console.log(`database exists: ${database}`);
      }
    }
  } finally {
    await client.end();
  }
  console.log('Done. Next: npm run db:migrate');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('Failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
