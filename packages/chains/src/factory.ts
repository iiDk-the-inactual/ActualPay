/**
 * Builds the adapters for the enabled assets from validated configuration.
 * One adapter per chain family; token assets share their chain's adapter.
 */
import type { AppConfig } from '@actualpay/config';
import { ASSETS, type ChainFamily } from '@actualpay/shared';
import { BitcoinCoreAdapter } from './adapters/bitcoin-core';
import { EvmAdapter } from './adapters/evm';
import { TronAdapter } from './adapters/tron';
import { XrplAdapter, XrplClientRequester } from './adapters/xrpl';
import type { WatchOnlyAdapter } from './types';

export interface AdapterDeps {
  /** Deposit addresses to watch on account-model chains (Ethereum, TRON). */
  readonly watchedAddresses: (chain: 'ethereum' | 'tron') => Promise<ReadonlySet<string>>;
}

export function createChainAdapters(
  config: AppConfig,
  deps: AdapterDeps,
): Map<ChainFamily, WatchOnlyAdapter> {
  const chains = new Set(config.enabledAssets.map((id) => ASSETS[id].chain));
  const adapters = new Map<ChainFamily, WatchOnlyAdapter>();
  const missing = (name: string) => new Error(`${name} is enabled but not configured`);

  for (const chain of chains) {
    switch (chain) {
      case 'bitcoin': {
        const c =
          config.chains.bitcoin ??
          (() => {
            throw missing('bitcoin');
          })();
        adapters.set(
          chain,
          new BitcoinCoreAdapter({
            chain,
            network: config.network,
            url: c.url,
            username: c.username,
            password: c.password,
            walletName: c.walletName,
            requiredConfirmations: c.confirmations,
            walletMode: 'descriptor',
          }),
        );
        break;
      }
      case 'litecoin': {
        const c =
          config.chains.litecoin ??
          (() => {
            throw missing('litecoin');
          })();
        adapters.set(
          chain,
          new BitcoinCoreAdapter({
            chain,
            network: config.network,
            url: c.url,
            username: c.username,
            password: c.password,
            walletName: c.walletName,
            requiredConfirmations: c.confirmations,
            walletMode: c.walletMode,
          }),
        );
        break;
      }
      case 'ethereum': {
        const c =
          config.chains.ethereum ??
          (() => {
            throw missing('ethereum');
          })();
        const contract = config.tokenContracts['usdt-erc20'];
        adapters.set(
          chain,
          new EvmAdapter({
            network: config.network,
            url: c.url,
            chainId: BigInt(c.chainId),
            ...(config.enabledAssets.includes('usdt-erc20') && contract
              ? { token: { assetId: 'usdt-erc20' as const, contract } }
              : {}),
            watchedAddresses: () => deps.watchedAddresses('ethereum'),
          }),
        );
        break;
      }
      case 'tron': {
        const c =
          config.chains.tron ??
          (() => {
            throw missing('tron');
          })();
        const contract = config.tokenContracts['usdt-trc20'];
        adapters.set(
          chain,
          new TronAdapter({
            network: config.network,
            url: c.url,
            ...(c.apiKey ? { apiKey: c.apiKey } : {}),
            ...(config.enabledAssets.includes('usdt-trc20') && contract
              ? { token: { assetId: 'usdt-trc20' as const, contract } }
              : {}),
            watchedAddresses: () => deps.watchedAddresses('tron'),
          }),
        );
        break;
      }
      case 'xrpl': {
        const c =
          config.chains.xrpl ??
          (() => {
            throw missing('xrpl');
          })();
        adapters.set(
          chain,
          new XrplAdapter({
            network: config.network,
            requester: new XrplClientRequester(c.url),
            ...(c.depositAccount ? { depositAccount: c.depositAccount } : {}),
          }),
        );
        break;
      }
    }
  }
  return adapters;
}
