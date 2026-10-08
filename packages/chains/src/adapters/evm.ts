/**
 * Ethereum adapter (watch-only): native ETH and one ERC-20 token (USDT).
 *
 * Works with any standard JSON-RPC endpoint (own node or provider).
 *
 * Detection:
 *  - native ETH: top-level transactions in each block whose `to` is a
 *    watched address and whose receipt status is success;
 *  - token: `eth_getLogs` for the token contract's `Transfer` events with
 *    `to` (topic 2) in the watched set; amounts come from the log data.
 *
 * Finality: a transfer is final once its block is at or below the node's
 * `finalized` block (proof-of-stake finality, ~13 minutes on mainnet). No
 * confirmation-count heuristics.
 *
 * Reorgs: each scan re-reads a small overlap behind the cursor so a block
 * replaced near the tip is rescanned; refs are stable, so re-reporting is
 * harmless. `recheck` re-reads the receipt and reports `missing` if the
 * transaction left the canonical chain or failed.
 *
 * Known limitation (documented in docs/chains.md): ETH sent *by a contract*
 * (internal transfers, e.g. from some smart-contract wallets or exchanges)
 * does not appear as a top-level transaction and is not detected here.
 * Balance reconciliation (Phase 6) surfaces such deposits for review.
 */
import type { AssetId, NetworkMode } from '@actualpay/shared';
import { validateEvmAddress } from '../addresses';
import { arr, hexInt, obj, optStr, str } from '../json-access';
import { ChainRpcError, jsonRpc } from '../rpc';
import type {
  ChainStatus,
  IncomingTransfer,
  ScanResult,
  TransferCheck,
  WatchOnlyAdapter,
} from '../types';

/** keccak256("Transfer(address,address,uint256)") */
export const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface EvmOptions {
  readonly network: NetworkMode;
  readonly url: string;
  /** Expected chain id; the adapter refuses to run against a different chain. */
  readonly chainId: bigint;
  readonly token?: { readonly assetId: AssetId; readonly contract: string };
  /** Current set of deposit addresses, in any case. */
  readonly watchedAddresses: () => Promise<ReadonlySet<string>>;
  readonly maxBlocksPerScan?: number;
  readonly reorgOverlap?: number;
  readonly timeoutMs?: number;
}

const ADDRESS_TOPIC_CHUNK = 100;

function topicFor(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function addressFromTopic(topic: string): string | null {
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(topic)) return null;
  return validateEvmAddress(`0x${topic.slice(26)}`);
}

export class EvmAdapter implements WatchOnlyAdapter {
  readonly chain = 'ethereum' as const;
  readonly network: NetworkMode;
  readonly assets: readonly AssetId[];
  readonly #o: EvmOptions;
  readonly #contract: string | null;
  #chainIdVerified = false;

  constructor(options: EvmOptions) {
    this.#o = options;
    this.network = options.network;
    if (options.token) {
      const contract = validateEvmAddress(options.token.contract);
      if (!contract) throw new Error('Invalid token contract address');
      this.#contract = contract;
      this.assets = ['eth', options.token.assetId];
    } else {
      this.#contract = null;
      this.assets = ['eth'];
    }
  }

  #call(method: string, params: readonly unknown[]): Promise<unknown> {
    return jsonRpc(this.#o.url, method, params, { timeoutMs: this.#o.timeoutMs ?? 20_000 });
  }

  async #verifyChain(): Promise<void> {
    if (this.#chainIdVerified) return;
    const id = hexInt(await this.#call('eth_chainId', []), 'chainId');
    if (id !== this.#o.chainId)
      throw new ChainRpcError(`RPC endpoint is chain ${id}, expected ${this.#o.chainId}`, false);
    this.#chainIdVerified = true;
  }

  async #heights(): Promise<{ tip: bigint; finalized: bigint }> {
    const tip = hexInt(await this.#call('eth_blockNumber', []), 'blockNumber');
    const finalizedBlock = await this.#call('eth_getBlockByNumber', ['finalized', false]);
    const finalized =
      finalizedBlock === null ? -1n : hexInt(obj(finalizedBlock, 'block')['number'], 'number');
    return { tip, finalized };
  }

  async status(): Promise<ChainStatus> {
    await this.#verifyChain();
    const { tip, finalized } = await this.#heights();
    const syncing = await this.#call('eth_syncing', []);
    return {
      chain: this.chain,
      network: this.network,
      tipHeight: tip,
      finalHeight: finalized < 0n ? 0n : finalized,
      synced: syncing === false,
    };
  }

  async #watched(): Promise<Set<string>> {
    const out = new Set<string>();
    for (const a of await this.#o.watchedAddresses()) {
      const checksummed = validateEvmAddress(a);
      if (checksummed) out.add(checksummed.toLowerCase());
    }
    return out;
  }

  async scanIncoming(cursor: string | null): Promise<ScanResult> {
    await this.#verifyChain();
    const { tip, finalized } = await this.#heights();
    if (cursor === null) return { transfers: [], cursor: tip.toString() };
    if (!/^[0-9]+$/.test(cursor)) throw new Error('Invalid EVM cursor');
    const last = BigInt(cursor);
    const overlap = BigInt(this.#o.reorgOverlap ?? 12);
    // Rescan a short window behind the cursor, but never below finality.
    let from = last + 1n - overlap;
    if (from <= finalized) from = finalized + 1n;
    if (from > last + 1n) from = last + 1n;
    if (from < 0n) from = 0n;
    const to = [tip, from + BigInt(this.#o.maxBlocksPerScan ?? 100) - 1n].reduce((a, b) =>
      a < b ? a : b,
    );
    if (from > to) return { transfers: [], cursor: last.toString() };

    const watched = await this.#watched();
    const transfers: IncomingTransfer[] = [];
    if (watched.size > 0) {
      for (let n = from; n <= to; n++)
        transfers.push(...(await this.#nativeInBlock(n, watched, tip, finalized)));
      if (this.#contract && this.#o.token)
        transfers.push(...(await this.#tokenLogs(from, to, watched, tip, finalized)));
    }
    return { transfers, cursor: (to > last ? to : last).toString() };
  }

  #position(blockNumber: bigint, tip: bigint, finalized: bigint) {
    return {
      confirmations: tip >= blockNumber ? tip - blockNumber + 1n : 0n,
      final: blockNumber <= finalized,
    };
  }

  async #nativeInBlock(
    n: bigint,
    watched: Set<string>,
    tip: bigint,
    finalized: bigint,
  ): Promise<IncomingTransfer[]> {
    const block = obj(
      await this.#call('eth_getBlockByNumber', [`0x${n.toString(16)}`, true]),
      'block',
    );
    const blockHash = str(block['hash'], 'hash');
    const out: IncomingTransfer[] = [];
    for (const raw of arr(block['transactions'], 'transactions')) {
      const tx = obj(raw, 'transaction');
      const toAddr = validateEvmAddress(optStr(tx['to']) ?? '');
      if (!toAddr || !watched.has(toAddr.toLowerCase())) continue;
      const value = hexInt(tx['value'], 'value');
      if (value === 0n) continue;
      const hash = str(tx['hash'], 'hash');
      const receipt = obj(await this.#call('eth_getTransactionReceipt', [hash]), 'receipt');
      if (receipt['status'] !== '0x1') continue;
      out.push({
        ref: `eth:${hash.toLowerCase()}:native`,
        assetId: 'eth',
        txHash: hash.toLowerCase(),
        toAddress: toAddr,
        amount: value,
        blockHeight: n,
        blockHash,
        ...this.#position(n, tip, finalized),
      });
    }
    return out;
  }

  #logToTransfer(
    log: Record<string, unknown>,
    tip: bigint,
    finalized: bigint,
  ): IncomingTransfer | null {
    const token = this.#o.token;
    if (!token || log['removed'] === true) return null;
    const [topic0, , topic2, ...extra] = arr(log['topics'], 'topics').map((t) => str(t, 'topic'));
    if (topic0?.toLowerCase() !== ERC20_TRANSFER_TOPIC || topic2 === undefined || extra.length > 0)
      return null;
    const emitter = validateEvmAddress(str(log['address'], 'address'));
    if (!emitter || emitter !== this.#contract) return null; // look-alike tokens are ignored
    const toAddress = addressFromTopic(topic2);
    if (!toAddress) return null;
    const amount = hexInt(log['data'], 'data');
    if (amount === 0n) return null;
    const blockNumber = hexInt(log['blockNumber'], 'blockNumber');
    const hash = str(log['transactionHash'], 'transactionHash').toLowerCase();
    return {
      ref: `eth:${hash}:${hexInt(log['logIndex'], 'logIndex').toString()}`,
      assetId: token.assetId,
      txHash: hash,
      toAddress,
      amount,
      blockHeight: blockNumber,
      blockHash: str(log['blockHash'], 'blockHash'),
      ...this.#position(blockNumber, tip, finalized),
    };
  }

  async #tokenLogs(
    from: bigint,
    to: bigint,
    watched: Set<string>,
    tip: bigint,
    finalized: bigint,
  ): Promise<IncomingTransfer[]> {
    const addresses = [...watched];
    const out: IncomingTransfer[] = [];
    for (let i = 0; i < addresses.length; i += ADDRESS_TOPIC_CHUNK) {
      const chunk = addresses.slice(i, i + ADDRESS_TOPIC_CHUNK).map(topicFor);
      const logs = arr(
        await this.#call('eth_getLogs', [
          {
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
            address: this.#contract,
            topics: [ERC20_TRANSFER_TOPIC, null, chunk],
          },
        ]),
        'logs',
      );
      for (const raw of logs) {
        const transfer = this.#logToTransfer(obj(raw, 'log'), tip, finalized);
        if (transfer && watched.has(transfer.toAddress.toLowerCase())) out.push(transfer);
      }
    }
    return out;
  }

  async recheck(ref: string): Promise<TransferCheck> {
    const match = /^eth:(0x[0-9a-f]{64}):(native|[0-9]+)$/.exec(ref);
    if (!match) throw new Error(`Not an Ethereum transfer ref: ${ref}`);
    const [, hash, which] = match as unknown as [string, string, string];
    await this.#verifyChain();
    const receiptRaw = await this.#call('eth_getTransactionReceipt', [hash]);
    if (receiptRaw === null) return { state: 'missing' };
    const receipt = obj(receiptRaw, 'receipt');
    if (receipt['status'] !== '0x1') return { state: 'missing' };
    const blockNumber = hexInt(receipt['blockNumber'], 'blockNumber');
    // The receipt must belong to the canonical block at that height.
    const canonical = obj(
      await this.#call('eth_getBlockByNumber', [`0x${blockNumber.toString(16)}`, false]),
      'block',
    );
    if (str(canonical['hash'], 'hash') !== str(receipt['blockHash'], 'blockHash'))
      return { state: 'missing' };
    const { tip, finalized } = await this.#heights();

    if (which === 'native') {
      const tx = obj(await this.#call('eth_getTransactionByHash', [hash]), 'transaction');
      const toAddr = validateEvmAddress(optStr(tx['to']) ?? '');
      const value = hexInt(tx['value'], 'value');
      if (!toAddr || value === 0n) return { state: 'missing' };
      return {
        state: 'present',
        transfer: {
          ref,
          assetId: 'eth',
          txHash: hash,
          toAddress: toAddr,
          amount: value,
          blockHeight: blockNumber,
          blockHash: str(receipt['blockHash'], 'blockHash'),
          ...this.#position(blockNumber, tip, finalized),
        },
      };
    }
    for (const raw of arr(receipt['logs'], 'logs')) {
      const log = obj(raw, 'log');
      if (hexInt(log['logIndex'], 'logIndex').toString() !== which) continue;
      const transfer = this.#logToTransfer(log, tip, finalized);
      return transfer ? { state: 'present', transfer } : { state: 'missing' };
    }
    return { state: 'missing' };
  }
}
