/**
 * XRP Ledger adapter (watch-only).
 *
 * One deposit account receives for every invoice; payments are matched by
 * DestinationTag. The account should have the `RequireDest` flag set (Phase
 * 4 checks this), so the ledger itself rejects untagged payments.
 *
 * Detection: `account_tx` over validated ledgers only. Validated ledgers are
 * final; the XRP Ledger has no reorgs.
 *
 * Partial-payment protection: the credited amount is always
 * `meta.delivered_amount`, never the transaction's `Amount`. A payment with
 * the tfPartialPayment flag can state a large `Amount` while delivering a
 * tiny one; using `Amount` would be the classic exploit. Payments delivering
 * a non-XRP currency (an object instead of a drops string) are ignored, and
 * `"unavailable"` delivered amounts (pre-2014 history) are rejected.
 */
import { Client } from 'xrpl';
import type { NetworkMode } from '@actualpay/shared';
import { validateXrplAddress } from '../addresses';
import { arr, int, obj, optStr, str } from '../json-access';
import { ChainRpcError } from '../rpc';
import type {
  ChainStatus,
  IncomingTransfer,
  ScanResult,
  TransferCheck,
  WatchOnlyAdapter,
} from '../types';

/** The subset of the WebSocket API we use; lets tests substitute fixtures. */
export interface XrplRequester {
  request(command: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** Production requester backed by xrpl.js (reconnecting WebSocket client). */
export class XrplClientRequester implements XrplRequester {
  readonly #client: Client;
  constructor(url: string) {
    this.#client = new Client(url, { timeout: 20_000 });
  }
  async request(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.#client.isConnected()) await this.#client.connect();
    try {
      const response: unknown = await this.#client.request(command as never);
      return obj(obj(response, 'xrpl response')['result'], 'xrpl result');
    } catch (error) {
      throw new ChainRpcError(
        `XRPL ${String(command['command'])}: ${error instanceof Error ? error.message : 'error'}`,
        true,
      );
    }
  }
  async close(): Promise<void> {
    if (this.#client.isConnected()) await this.#client.disconnect();
  }
}

export interface XrplOptions {
  readonly network: NetworkMode;
  readonly requester: XrplRequester;
  /** Required for scanning; `status()` and `reserves()` work without it. */
  readonly depositAccount?: string;
  readonly maxPages?: number;
}

const SYNCED_STATES = new Set(['full', 'proposing', 'validating']);

export class XrplAdapter implements WatchOnlyAdapter {
  readonly chain = 'xrpl' as const;
  readonly network: NetworkMode;
  readonly assets = ['xrp'] as const;
  readonly #o: XrplOptions;
  readonly #accountOrNull: string | null;

  constructor(options: XrplOptions) {
    if (options.depositAccount !== undefined && !validateXrplAddress(options.depositAccount))
      throw new Error('Invalid XRPL deposit account');
    this.#o = options;
    this.#accountOrNull = options.depositAccount ?? null;
    this.network = options.network;
  }

  get #account(): string {
    if (!this.#accountOrNull) throw new Error('XRPL deposit account is not configured');
    return this.#accountOrNull;
  }

  async status(): Promise<ChainStatus> {
    const state = obj(
      (await this.#o.requester.request({ command: 'server_state' }))['state'],
      'state',
    );
    const validated = state['validated_ledger']
      ? obj(state['validated_ledger'], 'validated_ledger')
      : null;
    const seq = validated ? int(validated['seq'], 'seq') : 0n;
    return {
      chain: this.chain,
      network: this.network,
      tipHeight: seq,
      finalHeight: seq,
      synced: validated !== null && SYNCED_STATES.has(str(state['server_state'], 'server_state')),
    };
  }

  /** Current reserve requirements in drops (read live: they change by validator vote). */
  async reserves(): Promise<{ base: bigint; perObject: bigint }> {
    const validated = obj(
      obj((await this.#o.requester.request({ command: 'server_state' }))['state'], 'state')[
        'validated_ledger'
      ],
      'validated_ledger',
    );
    return {
      base: int(validated['reserve_base'], 'reserve_base'),
      perObject: int(validated['reserve_inc'], 'reserve_inc'),
    };
  }

  /** Account flags needed by Phase 4 (RequireDest = 0x00020000 / lsfRequireDestTag). */
  async requiresDestinationTag(): Promise<boolean> {
    const data = obj(
      (
        await this.#o.requester.request({
          command: 'account_info',
          account: this.#account,
          ledger_index: 'validated',
        })
      )['account_data'],
      'account_data',
    );
    return (Number(int(data['Flags'], 'Flags')) & 0x00020000) !== 0;
  }

  /** Accepts API v2 (`tx_json` + `hash`) and v1 (`tx`) response shapes. */
  #toTransfer(entry: Record<string, unknown>): IncomingTransfer | null {
    if (entry['validated'] !== true) return null;
    const tx = obj(entry['tx_json'] ?? entry['tx'], 'tx');
    const meta = obj(entry['meta'], 'meta');
    const hash = (optStr(entry['hash']) ?? str(tx['hash'], 'hash')).toUpperCase();
    if (tx['TransactionType'] !== 'Payment' || tx['Destination'] !== this.#account) return null;
    if (meta['TransactionResult'] !== 'tesSUCCESS') return null;
    const delivered = meta['delivered_amount'];
    if (delivered === 'unavailable')
      throw new ChainRpcError(`delivered_amount unavailable for ${hash}`, false);
    if (typeof delivered !== 'string' || !/^[0-9]+$/.test(delivered)) return null; // non-XRP currency
    const amount = BigInt(delivered);
    if (amount === 0n) return null;
    const tag = tx['DestinationTag'];
    const ledger = int(entry['ledger_index'] ?? tx['ledger_index'], 'ledger_index');
    return {
      ref: `xrp:${hash}`,
      assetId: 'xrp',
      txHash: hash,
      toAddress: this.#account,
      ...(tag !== undefined ? { destinationTag: Number(int(tag, 'DestinationTag')) } : {}),
      amount,
      blockHeight: ledger,
      blockHash: null,
      confirmations: 1n,
      final: true,
    };
  }

  async scanIncoming(cursor: string | null): Promise<ScanResult> {
    if (cursor === null)
      return { transfers: [], cursor: (await this.status()).finalHeight.toString() };
    if (!/^[0-9]+$/.test(cursor)) throw new Error('Invalid XRPL cursor');
    const transfers: IncomingTransfer[] = [];
    let marker: unknown;
    let maxLedger = BigInt(cursor);
    for (let page = 0; page < (this.#o.maxPages ?? 50); page++) {
      const result = await this.#o.requester.request({
        command: 'account_tx',
        account: this.#account,
        ledger_index_min: Number(BigInt(cursor) + 1n),
        ledger_index_max: -1,
        forward: true,
        limit: 200,
        ...(marker !== undefined ? { marker } : {}),
      });
      for (const raw of arr(result['transactions'], 'transactions')) {
        const t = this.#toTransfer(obj(raw, 'transaction'));
        if (t) transfers.push(t);
      }
      const max = int(result['ledger_index_max'], 'ledger_index_max');
      if (max > maxLedger) maxLedger = max;
      marker = result['marker'];
      if (marker === undefined) break;
    }
    return { transfers, cursor: maxLedger.toString() };
  }

  async recheck(ref: string): Promise<TransferCheck> {
    const match = /^xrp:([0-9A-F]{64})$/.exec(ref);
    if (!match) throw new Error(`Not an XRPL transfer ref: ${ref}`);
    let result: Record<string, unknown>;
    try {
      result = await this.#o.requester.request({ command: 'tx', transaction: match[1] });
    } catch (error) {
      if (error instanceof ChainRpcError && /txnNotFound/.test(error.message))
        return { state: 'missing' };
      throw error;
    }
    const transfer = this.#toTransfer(result['tx_json'] ? result : { ...result, tx: result });
    return transfer ? { state: 'present', transfer } : { state: 'missing' };
  }
}
