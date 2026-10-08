/**
 * Bitcoin Core / Litecoin Core adapter (watch-only).
 *
 * Model: the operator's own node runs a dedicated *watch-only wallet*
 * (created with private keys disabled). ActualPay imports
 * `wpkh(<account xpub>/0/*)` with a range, and the node indexes every
 * payment to those addresses.
 *
 * Two wallet modes, because the two node implementations diverged:
 *  - `descriptor`: Bitcoin Core. Since v30 legacy wallets are removed and
 *    descriptor wallets + `importdescriptors` are the only option.
 *  - `legacy`: Litecoin Core. Its official 0.21.x release binaries are built
 *    without descriptor-wallet support ("Descriptor wallets not supported"),
 *    so a legacy watch-only wallet is used, and the same ranged descriptor is
 *    imported with `importmulti` (watchonly: true).
 *
 * Detection: `listsinceblock(cursor, requiredConfirmations)` returns every
 * wallet receive since the cursor block, and its `lastblock` is chosen so
 * that transfers keep being re-reported until they reach the required
 * depth. Reorgs are handled by the node (it rewinds to the fork point).
 * `recheck` uses `gettransaction`, whose confirmations go negative for
 * transactions conflicted out by a double spend.
 *
 * Amounts arrive as JSON decimals (e.g. 0.10000001) and are parsed from
 * their exact source text, never through floating point.
 */
import { parseAmount, type AssetId } from '@actualpay/shared';
import { HDKey } from '@scure/bip32';
import { deriveUtxoAddress } from '../derivation';
import { type UtxoNetwork } from '../addresses';
import { arr, bool, int, obj, optStr, str } from '../json-access';
import { basicAuth, ChainRpcError, jsonRpc } from '../rpc';
import type {
  ChainStatus,
  IncomingTransfer,
  ScanResult,
  TransferCheck,
  WatchOnlyAdapter,
} from '../types';

export interface BitcoinCoreOptions {
  readonly chain: 'bitcoin' | 'litecoin';
  readonly network: UtxoNetwork;
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly walletName: string;
  readonly requiredConfirmations: number;
  /** Defaults: bitcoin → descriptor, litecoin → legacy (see header). */
  readonly walletMode?: 'descriptor' | 'legacy';
  readonly timeoutMs?: number;
}

const XPUB_VERSION = { mainnet: 0x0488b21e, testnet: 0x043587cf, regtest: 0x043587cf } as const;

export class BitcoinCoreAdapter implements WatchOnlyAdapter {
  readonly chain: 'bitcoin' | 'litecoin';
  readonly network;
  readonly assets: readonly AssetId[];
  readonly #o: BitcoinCoreOptions;
  readonly #asset: AssetId;
  readonly #prefix: string;
  readonly #mode: 'descriptor' | 'legacy';

  constructor(options: BitcoinCoreOptions) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.walletName)) throw new Error('Invalid wallet name');
    if (!Number.isInteger(options.requiredConfirmations) || options.requiredConfirmations < 1)
      throw new Error('requiredConfirmations must be >= 1');
    this.#o = options;
    this.chain = options.chain;
    this.network = options.network === 'mainnet' ? ('mainnet' as const) : ('testnet' as const);
    this.#asset = options.chain === 'bitcoin' ? 'btc' : 'ltc';
    this.#prefix = this.#asset;
    this.assets = [this.#asset];
    this.#mode = options.walletMode ?? (options.chain === 'bitcoin' ? 'descriptor' : 'legacy');
  }

  #call(method: string, params: readonly unknown[], wallet = false): Promise<unknown> {
    const url = wallet
      ? `${this.#o.url.replace(/\/$/, '')}/wallet/${encodeURIComponent(this.#o.walletName)}`
      : this.#o.url;
    return jsonRpc(url, method, params, {
      headers: basicAuth(this.#o.username, this.#o.password),
      timeoutMs: this.#o.timeoutMs ?? 30_000,
    });
  }

  async status(): Promise<ChainStatus> {
    const info = obj(await this.#call('getblockchaininfo', []), 'getblockchaininfo');
    const blocks = int(info['blocks'], 'blocks');
    const headers = int(info['headers'], 'headers');
    const ibd = bool(info['initialblockdownload'], 'initialblockdownload');
    const finalHeight = blocks - BigInt(this.#o.requiredConfirmations) + 1n;
    return {
      chain: this.chain,
      network: this.network,
      tipHeight: blocks,
      finalHeight: finalHeight < 0n ? 0n : finalHeight,
      // A one-block header lead is normal while a new block is being validated.
      synced: !ibd && headers - blocks <= 1n,
    };
  }

  /**
   * Create (or load) the watch-only wallet and verify it cannot hold private
   * keys. Refuses to proceed with a wallet that has private keys enabled.
   */
  async ensureWatchWallet(): Promise<void> {
    const loaded = arr(await this.#call('listwallets', []), 'listwallets');
    if (!loaded.includes(this.#o.walletName)) {
      try {
        await this.#call('loadwallet', [this.#o.walletName]);
      } catch (error) {
        if (
          !(error instanceof ChainRpcError) ||
          (error.rpcCode !== -18 && !/not found|does not exist/i.test(error.message))
        )
          throw error;
        // createwallet name disable_private_keys blank passphrase avoid_reuse descriptors load_on_startup
        await this.#call('createwallet', [
          this.#o.walletName,
          true,
          true,
          '',
          false,
          this.#mode === 'descriptor',
          true,
        ]);
      }
    }
    const info = obj(await this.#call('getwalletinfo', [], true), 'getwalletinfo');
    if (info['private_keys_enabled'] !== false) {
      throw new Error(
        `Wallet "${this.#o.walletName}" has private keys enabled. ActualPay only uses watch-only wallets.`,
      );
    }
    const isDescriptor = info['descriptors'] === true;
    if (isDescriptor !== (this.#mode === 'descriptor')) {
      throw new Error(
        `Wallet "${this.#o.walletName}" is ${isDescriptor ? 'a descriptor' : 'a legacy'} wallet but ${this.#mode} mode is configured.`,
      );
    }
  }

  /** The descriptor ActualPay imports for an account key: receive chain, P2WPKH. */
  descriptorFor(account: HDKey): string {
    if (!account.publicKey || !account.chainCode)
      throw new Error('Account key is missing public data');
    // Nodes expect xpub/tpub encodings, not SLIP-132 zpub/vpub: re-encode the same key.
    const xpub = new HDKey({
      versions: { public: XPUB_VERSION[this.#o.network], private: 0 },
      depth: account.depth,
      index: account.index,
      parentFingerprint: account.parentFingerprint,
      chainCode: account.chainCode,
      publicKey: account.publicKey,
    }).publicExtendedKey;
    return `wpkh(${xpub}/0/*)`;
  }

  /**
   * Import (or extend) the watched range [0, rangeEnd]. Before importing,
   * the node's own derivation of the first addresses is compared with ours;
   * any mismatch (wrong network, wrong key, wrong path) aborts the import.
   */
  async watchAccount(account: HDKey, rangeEnd: number): Promise<void> {
    if (!Number.isInteger(rangeEnd) || rangeEnd < 0 || rangeEnd > 1_000_000)
      throw new RangeError('Invalid range');
    const info = obj(
      await this.#call('getdescriptorinfo', [this.descriptorFor(account)]),
      'getdescriptorinfo',
    );
    const desc = str(info['descriptor'], 'descriptor');
    const checksum = str(info['checksum'], 'checksum');
    const withChecksum = desc.includes('#') ? desc : `${desc}#${checksum}`;

    const sample = Math.min(rangeEnd, 4);
    const nodeAddresses = arr(
      await this.#call('deriveaddresses', [withChecksum, [0, sample]]),
      'deriveaddresses',
    ).map((a) => str(a, 'address'));
    const ours = Array.from({ length: sample + 1 }, (_, i) =>
      deriveUtxoAddress(this.chain, this.#o.network, account, i),
    );
    if (JSON.stringify(nodeAddresses) !== JSON.stringify(ours)) {
      throw new Error(
        'Node-derived addresses do not match ActualPay derivation; refusing to import the descriptor.',
      );
    }

    const request =
      this.#mode === 'descriptor'
        ? {
            method: 'importdescriptors',
            params: [
              [
                {
                  desc: withChecksum,
                  range: [0, rangeEnd],
                  timestamp: 'now',
                  active: false,
                  internal: false,
                },
              ],
            ],
          }
        : {
            method: 'importmulti',
            params: [
              [
                {
                  desc: withChecksum,
                  range: [0, rangeEnd],
                  timestamp: 'now',
                  watchonly: true,
                  internal: false,
                  keypool: false,
                },
              ],
              { rescan: false },
            ],
          };
    const result = arr(await this.#call(request.method, request.params, true), request.method);
    const first = obj(result[0], `${request.method} result`);
    if (first['success'] !== true) {
      const err = first['error'] ? obj(first['error'], 'error') : {};
      throw new ChainRpcError(
        `${request.method} failed: ${optStr(err['message']) ?? 'unknown'}`,
        false,
      );
    }
  }

  async #tip(): Promise<{ hash: string; height: bigint }> {
    const hash = str(await this.#call('getbestblockhash', []), 'bestblockhash');
    const header = obj(await this.#call('getblockheader', [hash]), 'blockheader');
    return { hash, height: int(header['height'], 'height') };
  }

  #toTransfer(entry: Record<string, unknown>, txid: string): IncomingTransfer | null {
    if (entry['category'] !== 'receive') return null;
    const confirmations = int(entry['confirmations'], 'confirmations');
    if (confirmations < 0n) return null; // conflicted (double-spent)
    const vout = int(entry['vout'], 'vout');
    const blockHash = optStr(entry['blockhash']) ?? null;
    const blockHeight =
      entry['blockheight'] !== undefined ? int(entry['blockheight'], 'blockheight') : null;
    return {
      ref: `${this.#prefix}:${txid}:${vout}`,
      assetId: this.#asset,
      txHash: txid,
      toAddress: str(entry['address'], 'address'),
      amount: parseAmount(str(entry['amount'], 'amount'), 8),
      blockHeight,
      blockHash,
      confirmations,
      final: confirmations >= BigInt(this.#o.requiredConfirmations),
    };
  }

  async scanIncoming(cursor: string | null): Promise<ScanResult> {
    if (cursor === null) return { transfers: [], cursor: (await this.#tip()).hash };
    if (!/^[0-9a-f]{64}$/.test(cursor)) throw new Error('Invalid UTXO cursor');
    const result = obj(
      await this.#call('listsinceblock', [cursor, this.#o.requiredConfirmations, true, true], true),
      'listsinceblock',
    );
    const transfers: IncomingTransfer[] = [];
    for (const raw of arr(result['transactions'], 'transactions')) {
      const entry = obj(raw, 'transaction');
      const transfer = this.#toTransfer(entry, str(entry['txid'], 'txid'));
      if (transfer) transfers.push(transfer);
    }
    return { transfers, cursor: str(result['lastblock'], 'lastblock') };
  }

  async recheck(ref: string): Promise<TransferCheck> {
    const match = new RegExp(`^${this.#prefix}:([0-9a-f]{64}):([0-9]+)$`).exec(ref);
    if (!match) throw new Error(`Not a ${this.#prefix} transfer ref: ${ref}`);
    const [, txid, vout] = match as unknown as [string, string, string];
    let tx: Record<string, unknown>;
    try {
      tx = obj(await this.#call('gettransaction', [txid, true], true), 'gettransaction');
    } catch (error) {
      if (error instanceof ChainRpcError && error.rpcCode === -5) return { state: 'missing' };
      throw error;
    }
    const confirmations = int(tx['confirmations'], 'confirmations');
    if (confirmations < 0n) return { state: 'missing' };
    for (const raw of arr(tx['details'], 'details')) {
      const detail = obj(raw, 'detail');
      if (detail['category'] === 'receive' && String(detail['vout']) === vout) {
        const transfer = this.#toTransfer(
          {
            ...detail,
            confirmations: tx['confirmations'],
            blockhash: tx['blockhash'],
            blockheight: tx['blockheight'],
          },
          txid,
        );
        return transfer ? { state: 'present', transfer } : { state: 'missing' };
      }
    }
    return { state: 'missing' };
  }
}
