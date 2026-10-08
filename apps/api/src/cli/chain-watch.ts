/**
 * Manual live check of a watch-only adapter against a real network.
 * Used to verify adapters on public testnets (see TASKS.md, Phase 3).
 *
 *   npm run chain:watch -- --chain ethereum --address 0x… --from 7000000
 *   npm run chain:watch -- --chain tron --address T… --since-minutes 120
 *   npm run chain:watch -- --chain xrpl --from 1234567        (uses XRPL_DEPOSIT_ACCOUNT)
 *   npm run chain:watch -- --chain bitcoin --xpub tpub… --index 0 --from <blockhash>
 *
 * For Bitcoin/Litecoin it creates/loads the configured watch-only wallet and
 * imports the descriptor range [0, index+20]. Read-only otherwise.
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '@actualpay/config';
import {
  BitcoinCoreAdapter,
  createChainAdapters,
  deriveUtxoAddress,
  parseExtendedPublicKey,
  type IncomingTransfer,
} from '@actualpay/chains';
import type { ChainFamily } from '@actualpay/shared';

function print(t: IncomingTransfer): void {
  const tag = t.destinationTag !== undefined ? ` tag=${t.destinationTag}` : '';
  console.log(
    `${t.final ? 'FINAL  ' : 'PENDING'} ${t.assetId.padEnd(10)} amount=${t.amount} (base units) to=${t.toAddress}${tag} conf=${t.confirmations} ref=${t.ref}`,
  );
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      chain: { type: 'string' },
      address: { type: 'string' },
      from: { type: 'string' },
      'since-minutes': { type: 'string' },
      xpub: { type: 'string' },
      index: { type: 'string' },
    },
  });
  const chain = values.chain as ChainFamily | undefined;
  if (!chain) {
    console.error(
      'Usage: npm run chain:watch -- --chain <bitcoin|litecoin|ethereum|tron|xrpl> [options]',
    );
    return 2;
  }
  const config = loadConfig();
  const watched = new Set(values.address ? [values.address] : []);
  const adapter = createChainAdapters(config, {
    watchedAddresses: () => Promise.resolve(watched),
  }).get(chain);
  if (!adapter) {
    console.error(`${chain} is not enabled (ENABLED_ASSETS).`);
    return 2;
  }
  const status = await adapter.status();
  console.log(
    `${chain}: tip=${status.tipHeight} final=${status.finalHeight} synced=${status.synced}`,
  );

  let cursor: string;
  if (adapter instanceof BitcoinCoreAdapter) {
    if (!values.xpub || !values.from) {
      console.error(
        '--xpub <account tpub/xpub> and --from <block hash> are required for bitcoin/litecoin',
      );
      return 2;
    }
    const account = parseExtendedPublicKey(values.xpub);
    const index = Number(values.index ?? '0');
    await adapter.ensureWatchWallet();
    await adapter.watchAccount(account, index + 20);
    console.log(
      `Watching ${chain} account; address #${index} = ${deriveUtxoAddress(chain as 'bitcoin' | 'litecoin', config.network, account, index)}`,
    );
    cursor = values.from;
  } else if (chain === 'tron') {
    const minutes = Number(values['since-minutes'] ?? '60');
    cursor = JSON.stringify({ v: 1, since: Date.now() - minutes * 60_000 });
  } else {
    if (!values.from) {
      console.error('--from <block or ledger number> is required');
      return 2;
    }
    cursor = String(BigInt(values.from) - 1n);
  }

  let total = 0;
  for (let round = 0; round < 50; round++) {
    const result = await adapter.scanIncoming(cursor);
    result.transfers.forEach(print);
    total += result.transfers.length;
    if (result.cursor === cursor) break;
    cursor = result.cursor;
    if (chain === 'tron' || chain === 'xrpl' || adapter instanceof BitcoinCoreAdapter) break;
  }
  console.log(`${total} transfer(s) found. Resume cursor: ${cursor}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('Failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
