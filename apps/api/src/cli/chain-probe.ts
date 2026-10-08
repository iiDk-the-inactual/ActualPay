/**
 * Check connectivity to every enabled chain backend and print its status.
 *
 *   npm run chain:probe
 *
 * Read-only: it never creates wallets, imports keys or sends anything.
 * Exit code 0 only if every enabled chain is reachable and synced.
 */
import { loadConfig } from '@actualpay/config';
import { createChainAdapters, XrplAdapter } from '@actualpay/chains';

async function main(): Promise<number> {
  const config = loadConfig();
  console.log(
    `Network mode: ${config.network}; enabled assets: ${config.enabledAssets.join(', ')}`,
  );
  const adapters = createChainAdapters(config, {
    watchedAddresses: () => Promise.resolve(new Set()),
  });
  let failures = 0;
  for (const [chain, adapter] of adapters) {
    try {
      const status = await adapter.status();
      const behind = status.tipHeight - status.finalHeight;
      console.log(
        `${status.synced ? 'OK  ' : 'SYNC'}  ${chain.padEnd(9)} tip=${status.tipHeight} final=${status.finalHeight} (${behind} behind tip) assets=${adapter.assets.join(',')}`,
      );
      if (!status.synced) failures++;
      if (adapter instanceof XrplAdapter) {
        const reserves = await adapter.reserves();
        console.log(
          `      xrpl reserves: base=${reserves.base} drops, per object=${reserves.perObject} drops`,
        );
        if (config.chains.xrpl?.depositAccount) {
          const requireDest = await adapter.requiresDestinationTag().catch(() => null);
          console.log(
            `      deposit account RequireDest: ${requireDest === null ? 'account not found' : requireDest ? 'set' : 'NOT SET (untagged payments cannot be attributed)'}`,
          );
        }
      }
    } catch (error) {
      failures++;
      console.log(
        `FAIL  ${chain.padEnd(9)} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return failures === 0 ? 0 : 1;
}

process.exitCode = await main();
// The XRPL WebSocket client keeps the event loop alive; exit explicitly.
process.exit(process.exitCode);
