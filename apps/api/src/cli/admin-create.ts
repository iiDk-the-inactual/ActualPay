/**
 * Create the first platform administrator.
 *
 *   npm run admin:create -- --email you@example.com --name "Your Name"
 *
 * The password is read from an interactive hidden prompt, or from the
 * ACTUALPAY_ADMIN_PASSWORD environment variable for automation. It is never
 * accepted as a command-line argument (those end up in shell history and
 * process listings).
 */
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createPlatformAdmin } from '@actualpay/auth';
import { resolveFileSecrets } from '@actualpay/config';
import { createDb } from '@actualpay/database';

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('No TTY available; set ACTUALPAY_ADMIN_PASSWORD instead.'));
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = rl as unknown as { _writeToOutput: (s: string) => void };
    let prompted = false;
    output._writeToOutput = (s: string) => {
      if (!prompted) {
        process.stdout.write(s);
        prompted = true;
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' } },
  });
  if (!values.email) {
    console.error('Usage: npm run admin:create -- --email <email> [--name "Display Name"]');
    return 2;
  }
  const env = resolveFileSecrets(process.env, [
    'DATABASE_URL',
    'DATABASE_SSL',
    'ACTUALPAY_ADMIN_PASSWORD',
  ]);
  if (!env['DATABASE_URL']) {
    console.error('DATABASE_URL (or DATABASE_URL_FILE) is required.');
    return 2;
  }
  let password = env['ACTUALPAY_ADMIN_PASSWORD'];
  if (!password) {
    password = await promptHidden('Password (min 12 characters): ');
    const confirm = await promptHidden('Confirm password: ');
    if (password !== confirm) {
      console.error('Passwords do not match.');
      return 1;
    }
  }
  const db = createDb({
    url: env['DATABASE_URL'],
    poolMax: 1,
    ssl: env['DATABASE_SSL'] === 'true',
    applicationName: 'actualpay-cli',
  });
  try {
    const id = await createPlatformAdmin(
      { db },
      { email: values.email, password, displayName: values.name ?? 'Administrator' },
    );
    console.log(`Platform administrator created: ${id}`);
    console.log('Next: sign in and enable two-factor authentication immediately.');
    return 0;
  } catch (error) {
    console.error('Failed:', error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await db.destroy();
  }
}

process.exitCode = await main();
