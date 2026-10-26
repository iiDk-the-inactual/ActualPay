/**
 * Talking to the nodes about OUTGOING transactions: reading what the signer
 * needs (nonces, coins, fees), broadcasting a signed transaction, and following
 * it to confirmation.
 *
 * Nothing here can sign. The signer builds and signs; these classes only read
 * chain state and hand finished bytes to a node. Broadcasting is idempotent:
 * sending a transaction a node already knows is a success, because the txid was
 * stored before the first attempt (docs/withdrawals.md).
 */
import { parseAmount, type ChainFamily, type NetworkMode } from '@actualpay/shared';
import { arr, hexInt, int, obj, optStr, str } from './json-access';
import { basicAuth, ChainRpcError, jsonRpc } from './rpc';
import type { UtxoNetwork } from './addresses';

export type BroadcastResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly permanent: boolean; readonly error: string };

export type OutgoingStatus =
  | { readonly state: 'unknown' }
  | { readonly state: 'pending' }
  | { readonly state: 'conflicted' }
  | {
      readonly state: 'mined';
      readonly confirmations: bigint;
      readonly blockHeight: bigint;
      /** The chain's finality rule is met. */
      readonly final: boolean;
      /** False for an EVM transaction that was mined but reverted. */
      readonly success: boolean;
      /** Exact fee paid, when the chain reports it (EVM). UTXO fees are known at signing. */
      readonly networkFee: bigint | null;
    };

export interface OutgoingChain {
  readonly chain: ChainFamily;
  readonly network: NetworkMode;
  broadcast(raw: string, txid: string): Promise<BroadcastResult>;
  status(txid: string): Promise<OutgoingStatus>;
}

const EVM_KNOWN =
  /already known|known transaction|already imported|already in the pool|already exists/i;

export class EvmNode implements OutgoingChain {
  readonly chain = 'ethereum' as const;
  constructor(
    readonly network: NetworkMode,
    private readonly url: string,
    private readonly chainId: bigint,
    private readonly timeoutMs = 30_000,
  ) {}

  call(method: string, params: readonly unknown[] = []): Promise<unknown> {
    return jsonRpc(this.url, method, params, { timeoutMs: this.timeoutMs });
  }

  async verifyChain(): Promise<void> {
    const id = hexInt(await this.call('eth_chainId'), 'eth_chainId');
    if (id !== this.chainId)
      throw new Error(`RPC endpoint is chain ${id}, expected ${this.chainId}`);
  }

  async nonce(address: string): Promise<bigint> {
    return hexInt(await this.call('eth_getTransactionCount', [address, 'pending']), 'nonce');
  }

  async balance(address: string): Promise<bigint> {
    return hexInt(await this.call('eth_getBalance', [address, 'latest']), 'balance');
  }

  async tokenBalance(contract: string, holder: string): Promise<bigint> {
    const data = `0x70a08231${holder.slice(2).toLowerCase().padStart(64, '0')}`;
    return hexInt(await this.call('eth_call', [{ to: contract, data }, 'latest']), 'balanceOf');
  }

  async feeData(): Promise<{ baseFee: bigint; priorityFee: bigint }> {
    const block = obj(await this.call('eth_getBlockByNumber', ['latest', false]), 'block');
    const baseFee =
      block['baseFeePerGas'] === undefined ? 0n : hexInt(block['baseFeePerGas'], 'baseFee');
    let priorityFee = 1_000_000_000n; // 1 gwei if the node cannot suggest one
    try {
      priorityFee = hexInt(await this.call('eth_maxPriorityFeePerGas'), 'priority');
    } catch {
      /* optional RPC */
    }
    return { baseFee, priorityFee };
  }

  async estimateGas(tx: {
    from: string;
    to: string;
    value?: bigint;
    data?: string;
  }): Promise<bigint> {
    return hexInt(
      await this.call('eth_estimateGas', [
        {
          from: tx.from,
          to: tx.to,
          ...(tx.value !== undefined ? { value: `0x${tx.value.toString(16)}` } : {}),
          ...(tx.data ? { data: tx.data } : {}),
        },
      ]),
      'estimateGas',
    );
  }

  async broadcast(raw: string, txid: string): Promise<BroadcastResult> {
    try {
      await this.call('eth_sendRawTransaction', [raw]);
      return { ok: true };
    } catch (error) {
      if (!(error instanceof ChainRpcError))
        return { ok: false, permanent: false, error: 'node unreachable' };
      if (EVM_KNOWN.test(error.message)) return { ok: true };
      if (error.retryable || error.rpcCode === undefined)
        return { ok: false, permanent: false, error: 'node unavailable' };
      // "nonce too low" is fine if OUR transaction is the one that used the nonce.
      if (/nonce too low/i.test(error.message)) {
        const status = await this.status(txid);
        if (status.state === 'mined' || status.state === 'pending') return { ok: true };
      }
      return { ok: false, permanent: true, error: error.message.slice(0, 200) };
    }
  }

  async status(txid: string): Promise<OutgoingStatus> {
    const receiptRaw = await this.call('eth_getTransactionReceipt', [txid]);
    if (receiptRaw === null || receiptRaw === undefined) {
      const tx = await this.call('eth_getTransactionByHash', [txid]);
      return tx === null || tx === undefined ? { state: 'unknown' } : { state: 'pending' };
    }
    const receipt = obj(receiptRaw, 'receipt');
    const blockNumber = hexInt(receipt['blockNumber'], 'blockNumber');
    const tip = hexInt(await this.call('eth_blockNumber'), 'blockNumber');
    let finalized = 0n;
    try {
      const block = obj(await this.call('eth_getBlockByNumber', ['finalized', false]), 'finalized');
      finalized = hexInt(block['number'], 'number');
    } catch {
      /* a node without a finalized tag never reports final */
    }
    const gasUsed = hexInt(receipt['gasUsed'], 'gasUsed');
    const price = hexInt(receipt['effectiveGasPrice'], 'effectiveGasPrice');
    return {
      state: 'mined',
      confirmations: tip >= blockNumber ? tip - blockNumber + 1n : 1n,
      blockHeight: blockNumber,
      final: blockNumber <= finalized,
      success: receipt['status'] === '0x1',
      networkFee: gasUsed * price,
    };
  }
}

export interface UtxoNodeOptions {
  readonly chain: 'bitcoin' | 'litecoin';
  readonly network: UtxoNetwork;
  readonly url: string;
  readonly username: string;
  readonly password: string;
  /** Watch-only wallet that tracks the hot wallet's address (no private keys). */
  readonly walletName: string;
  readonly requiredConfirmations: number;
  readonly walletMode?: 'descriptor' | 'legacy';
  readonly timeoutMs?: number;
}

export interface Utxo {
  readonly txid: string;
  readonly vout: number;
  readonly amount: bigint;
}

export class UtxoNode implements OutgoingChain {
  readonly chain: 'bitcoin' | 'litecoin';
  readonly network: NetworkMode;
  readonly #o: UtxoNodeOptions;
  readonly #mode: 'descriptor' | 'legacy';

  constructor(options: UtxoNodeOptions) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.walletName)) throw new Error('Invalid wallet name');
    this.#o = options;
    this.chain = options.chain;
    this.network = options.network === 'mainnet' ? 'mainnet' : 'testnet';
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

  /**
   * Make sure a watch-only wallet exists that tracks `address` (a FRESH hot
   * wallet address, so importing from "now" misses nothing).
   */
  async ensureHotWallet(address: string): Promise<void> {
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
    if (info['private_keys_enabled'] !== false)
      throw new Error(
        `Wallet "${this.#o.walletName}" has private keys enabled; refusing to use it.`,
      );
    if (this.#mode === 'descriptor') {
      const descriptorInfo = obj(
        await this.#call('getdescriptorinfo', [`addr(${address})`]),
        'descriptor',
      );
      const desc = `${str(descriptorInfo['descriptor'], 'descriptor').split('#')[0]}#${str(descriptorInfo['checksum'], 'checksum')}`;
      const result = arr(
        await this.#call('importdescriptors', [[{ desc, timestamp: 'now' }]], true),
        'importdescriptors',
      );
      const first = obj(result[0], 'importdescriptors result');
      if (first['success'] !== true) throw new Error('Could not import the hot wallet address');
    } else {
      await this.#call('importaddress', [address, 'hot', false], true);
    }
  }

  async tipHeight(): Promise<bigint> {
    return int(await this.#call('getblockcount', []), 'getblockcount');
  }

  async listUnspent(address: string, minConfirmations = 1): Promise<Utxo[]> {
    const rows = arr(
      await this.#call('listunspent', [minConfirmations, 9_999_999, [address]], true),
      'listunspent',
    );
    return rows.map((raw) => {
      const row = obj(raw, 'unspent');
      return {
        txid: str(row['txid'], 'txid'),
        vout: Number(int(row['vout'], 'vout')),
        amount: parseAmount(str(row['amount'], 'amount'), 8),
      };
    });
  }

  /** Satoshis per virtual byte, at least 1. */
  async feeRate(targetBlocks = 6): Promise<bigint> {
    let btcPerKvb: string | null = null;
    try {
      const estimate = obj(
        await this.#call('estimatesmartfee', [targetBlocks]),
        'estimatesmartfee',
      );
      btcPerKvb = optStr(estimate['feerate']) ?? null;
    } catch {
      /* fall back below */
    }
    if (btcPerKvb === null) {
      const pool = obj(await this.#call('getmempoolinfo', []), 'getmempoolinfo');
      btcPerKvb = optStr(pool['mempoolminfee']) ?? '0.00001';
    }
    const satPerKvb = parseAmount(btcPerKvb, 8, { allowZero: true });
    const perVbyte = (satPerKvb + 999n) / 1000n;
    return perVbyte < 1n ? 1n : perVbyte;
  }

  async broadcast(raw: string): Promise<BroadcastResult> {
    try {
      await this.#call('sendrawtransaction', [raw]);
      return { ok: true };
    } catch (error) {
      if (!(error instanceof ChainRpcError))
        return { ok: false, permanent: false, error: 'node unreachable' };
      // -27: already in the chain; -26 with "txn-already-in-mempool": already known.
      if (
        error.rpcCode === -27 ||
        /already in (block chain|the mempool)|txn-already-in-mempool|already have transaction/i.test(
          error.message,
        )
      )
        return { ok: true };
      if (error.retryable || error.rpcCode === undefined || error.rpcCode === -28)
        return { ok: false, permanent: false, error: 'node unavailable' };
      return { ok: false, permanent: true, error: error.message.slice(0, 200) };
    }
  }

  async status(txid: string): Promise<OutgoingStatus> {
    let tx: Record<string, unknown>;
    try {
      tx = obj(await this.#call('gettransaction', [txid, true], true), 'gettransaction');
    } catch (error) {
      if (error instanceof ChainRpcError && error.rpcCode === -5) return { state: 'unknown' };
      throw error;
    }
    const confirmations = int(tx['confirmations'], 'confirmations');
    if (confirmations < 0n) return { state: 'conflicted' };
    if (confirmations === 0n) return { state: 'pending' };
    return {
      state: 'mined',
      confirmations,
      blockHeight: int(tx['blockheight'], 'blockheight'),
      final: confirmations >= BigInt(this.#o.requiredConfirmations),
      success: true,
      networkFee: null,
    };
  }
}
