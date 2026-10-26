/**
 * Signer process: the only place hot-wallet keys exist.
 *
 *   npm run signer:init       create the keystore (prints the recovery words ONCE)
 *   npm run signer:addresses  show the hot-wallet addresses (no passphrase needed)
 *   npm run signer:once       sign everything currently approved, then exit
 *   npm run signer:start      run forever
 *
 * Environment: the usual configuration (database, nodes, WITHDRAWAL_SEAL_KEY)
 * plus SIGNER_KEYSTORE_PATH (default ./secrets/signer-keystore.json) and the
 * passphrase in SIGNER_PASSPHRASE or SIGNER_PASSPHRASE_FILE. Run it on its own
 * host or container, with outbound access only to the database and your nodes
 * and NO inbound network access: it never listens on a port.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createOutgoingNodes } from '@actualpay/chains';
import { loadConfig } from '@actualpay/config';
import { createDb, runLeased } from '@actualpay/database';
import { createLogger } from '@actualpay/shared';
import {
  createKeystore,
  signApprovedWithdrawals,
  unlockKeystore,
  type KeystoreFile,
} from '@actualpay/signer';

function passphrase(): string {
  const file = process.env['SIGNER_PASSPHRASE_FILE'];
  const direct = process.env['SIGNER_PASSPHRASE'];
  if (file && direct)
    throw new Error('Set only one of SIGNER_PASSPHRASE and SIGNER_PASSPHRASE_FILE.');
  const value = file ? readFileSync(file, 'utf8').replace(/\r?\n$/, '') : direct;
  if (!value) throw new Error('Set SIGNER_PASSPHRASE or SIGNER_PASSPHRASE_FILE.');
  return value;
}

const keystorePath = resolve(
  process.env['SIGNER_KEYSTORE_PATH'] ?? './secrets/signer-keystore.json',
);

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'start';
  const config = loadConfig();

  if (mode === 'init') {
    if (existsSync(keystorePath))
      throw new Error(`${keystorePath} already exists; refusing to overwrite it.`);
    const { file, mnemonic } = createKeystore({
      passphrase: passphrase(),
      network: config.network,
    });
    mkdirSync(dirname(keystorePath), { recursive: true });
    writeFileSync(keystorePath, JSON.stringify(file, null, 2), { mode: 0o600 });
    chmodSync(keystorePath, 0o600);
    out('');
    out('KEYSTORE CREATED. WRITE DOWN THESE 24 WORDS NOW. THEY ARE SHOWN ONCE.');
    out('Anyone with them can take everything in the hot wallets; without them and');
    out('without this file and passphrase, the funds are unrecoverable.');
    out('');
    out(mnemonic);
    out('');
    out(`Network: ${config.network}`);
    for (const [chain, address] of Object.entries(file.addresses))
      out(`${chain.padEnd(9)} ${address}`);
    out('');
    out('Next: register each address as a hot wallet (POST /v1/admin/hot-wallets), then');
    out('fund it. See docs/withdrawals.md.');
    return;
  }

  const file = JSON.parse(readFileSync(keystorePath, 'utf8')) as KeystoreFile;
  if (mode === 'addresses') {
    out(JSON.stringify({ network: file.network, addresses: file.addresses }, null, 2));
    return;
  }
  if (file.network !== config.network)
    throw new Error(`The keystore is for ${file.network} but NETWORK_MODE is ${config.network}.`);
  if (config.custody.mode !== 'platform')
    throw new Error('The signer only runs with CUSTODY_MODE=platform.');
  const sealKey = config.custody.sealKey;
  if (!sealKey) throw new Error('WITHDRAWAL_SEAL_KEY is required.');

  const logger = createLogger({ name: 'actualpay-signer', level: config.logLevel });
  const keystore = unlockKeystore(file, passphrase());
  const db = createDb({
    url: config.database.url,
    poolMax: 4,
    ssl: config.database.ssl,
    applicationName: 'actualpay-signer',
  });
  await sql`SELECT 1`.execute(db);

  const nodes = createOutgoingNodes(config);
  const deps = {
    db,
    logger,
    keystore,
    sealKey,
    network: config.network,
    tokenContracts: config.tokenContracts,
    ...(nodes.evm ? { evm: nodes.evm } : {}),
    utxo: nodes.utxo,
  };
  const owner = `signer-${randomUUID().slice(0, 8)}`;
  const pass = async () => {
    // One signer at a time per database, however many are started.
    const run = await runLeased(db, { name: 'signer', owner, ttlSeconds: 120 }, () =>
      signApprovedWithdrawals(deps),
    );
    return run.ran
      ? run.value
      : { signed: [], refused: [], skipped: 'another signer holds the lease' };
  };

  if (mode === 'once') {
    out(JSON.stringify(await pass(), null, 2));
    keystore.lock();
    await db.destroy();
    return;
  }

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const tick = async (): Promise<void> => {
    try {
      const report = await pass();
      if ('signed' in report && report.signed.length > 0)
        logger.info({ signed: report.signed.length }, 'signed withdrawals');
    } catch (error) {
      logger.error({ err: error }, 'signing pass failed');
    }
    if (!stopped)
      timer = setTimeout(() => {
        inFlight = tick();
      }, 5_000);
  };
  inFlight = tick();
  const shutdown = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
    void inFlight.then(async () => {
      keystore.lock();
      await db.destroy();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  logger.info({ addresses: file.addresses }, 'signer started');
}

main().catch((error: unknown) => {
  console.error('Signer failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
