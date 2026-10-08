/**
 * TRON adapter (watch-only): native TRX and one TRC-20 token (USDT).
 *
 * Uses the TronGrid-compatible HTTP API (TronGrid, a third-party provider,
 * or a self-hosted java-tron node with the event plugin):
 *  - `/wallet/getnowblock`, `/walletsolidity/getnowblock` for heights;
 *  - `/v1/accounts/{addr}/transactions` (TRX) and
 *    `/v1/accounts/{addr}/transactions/trc20` (TRC-20) with
 *    `only_confirmed=true`, `only_to=true`, `min_timestamp`, `order_by`;
 *  - `/v1/transactions/{id}/events` to get each Transfer's `event_index`,
 *    which makes refs unique even when one transaction pays an address twice.
 *
 * Finality: `only_confirmed=true` returns solidified (irreversible) data
 * only, so every reported transfer is final. Unconfirmed data is never used
 * for crediting.
 *
 * Safety checks: TRX transfers must be `TransferContract` with result
 * SUCCESS; TRC-20 transfers must be emitted by the configured contract
 * (look-alike tokens with the same symbol are ignored).
 *
 * Known limitation: TRX sent by a contract (internal transactions) is not
 * reported by the account transaction list and is not detected here.
 */
import type { AssetId, NetworkMode } from '@actualpay/shared';
import { encodeTronAddress, validateTronAddress } from '../addresses';
import { arr, int, obj, optStr, str } from '../json-access';
import { ChainRpcError, httpJson } from '../rpc';
import type {
  ChainStatus,
  IncomingTransfer,
  ScanResult,
  TransferCheck,
  WatchOnlyAdapter,
} from '../types';

export interface TronOptions {
  readonly network: NetworkMode;
  readonly url: string;
  readonly apiKey?: string;
  readonly token?: { readonly assetId: AssetId; readonly contract: string };
  readonly watchedAddresses: () => Promise<ReadonlySet<string>>;
  readonly timeoutMs?: number;
  /** Re-read this much history before the cursor to tolerate equal timestamps. */
  readonly overlapMs?: number;
  readonly maxPagesPerAddress?: number;
}

/** Normalise TRON addresses that arrive as base58, 41-prefixed hex, or 0x-prefixed 20-byte hex. */
export function normalizeTronAddress(value: string): string | null {
  if (value.startsWith('T')) return validateTronAddress(value);
  const hex = value.replace(/^0x/, '').toLowerCase();
  if (/^41[0-9a-f]{40}$/.test(hex)) return encodeTronAddress(Buffer.from(hex.slice(2), 'hex'));
  if (/^[0-9a-f]{40}$/.test(hex)) return encodeTronAddress(Buffer.from(hex, 'hex'));
  return null;
}

interface Cursor {
  readonly v: 1;
  readonly since: number;
}

export class TronAdapter implements WatchOnlyAdapter {
  readonly chain = 'tron' as const;
  readonly network: NetworkMode;
  readonly assets: readonly AssetId[];
  readonly #o: TronOptions;
  readonly #contract: string | null;

  constructor(options: TronOptions) {
    this.#o = options;
    this.network = options.network;
    this.#contract = options.token ? validateTronAddress(options.token.contract) : null;
    if (options.token && !this.#contract) throw new Error('Invalid TRC-20 contract address');
    this.assets = options.token ? ['trx', options.token.assetId] : ['trx'];
  }

  #headers(): Record<string, string> {
    return this.#o.apiKey ? { 'TRON-PRO-API-KEY': this.#o.apiKey } : {};
  }

  #get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(path, this.#o.url);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return httpJson(
      url.toString(),
      { method: 'GET' },
      { headers: this.#headers(), timeoutMs: this.#o.timeoutMs ?? 20_000 },
    );
  }

  #post(path: string, body: unknown): Promise<unknown> {
    return httpJson(
      new URL(path, this.#o.url).toString(),
      { method: 'POST', body },
      { headers: this.#headers(), timeoutMs: this.#o.timeoutMs ?? 20_000 },
    );
  }

  async #heights(): Promise<{ tip: bigint; solid: bigint; tipTimestamp: number }> {
    const now = obj(
      obj(obj(await this.#post('/wallet/getnowblock', {}), 'block')['block_header'], 'header')[
        'raw_data'
      ],
      'raw_data',
    );
    const solid = obj(
      obj(
        obj(await this.#post('/walletsolidity/getnowblock', {}), 'block')['block_header'],
        'header',
      )['raw_data'],
      'raw_data',
    );
    return {
      tip: int(now['number'], 'number'),
      solid: int(solid['number'], 'number'),
      tipTimestamp: Number(int(now['timestamp'], 'timestamp')),
    };
  }

  async status(): Promise<ChainStatus> {
    const { tip, solid, tipTimestamp } = await this.#heights();
    return {
      chain: this.chain,
      network: this.network,
      tipHeight: tip,
      finalHeight: solid,
      synced: Math.abs(Date.now() - tipTimestamp) < 180_000,
    };
  }

  /** Paginated GET of a TronGrid v1 list endpoint. */
  async #list(path: string, query: Record<string, string>): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let fingerprint: string | undefined;
    for (let page = 0; page < (this.#o.maxPagesPerAddress ?? 25); page++) {
      const body = obj(
        await this.#get(path, { ...query, ...(fingerprint ? { fingerprint } : {}) }),
        'list',
      );
      if (body['success'] === false) throw new ChainRpcError(`TronGrid error on ${path}`, true);
      for (const item of arr(body['data'], 'data')) out.push(obj(item, 'item'));
      const meta = body['meta'] ? obj(body['meta'], 'meta') : {};
      fingerprint = optStr(meta['fingerprint']);
      if (!fingerprint) break;
    }
    return out;
  }

  #nativeTransfer(
    tx: Record<string, unknown>,
    watched: Set<string>,
    tip: bigint,
  ): IncomingTransfer | null {
    const ret = arr(tx['ret'] ?? [], 'ret');
    if (ret.length === 0 || obj(ret[0], 'ret')['contractRet'] !== 'SUCCESS') return null;
    const contracts = arr(obj(tx['raw_data'], 'raw_data')['contract'], 'contract');
    if (contracts.length !== 1) return null;
    const contract = obj(contracts[0], 'contract');
    if (contract['type'] !== 'TransferContract') return null;
    const value = obj(obj(contract['parameter'], 'parameter')['value'], 'value');
    const to = normalizeTronAddress(str(value['to_address'], 'to_address'));
    if (!to || !watched.has(to)) return null;
    const amount = int(value['amount'], 'amount');
    if (amount <= 0n) return null;
    const txid = str(tx['txID'], 'txID').toLowerCase();
    const blockNumber = int(tx['blockNumber'], 'blockNumber');
    return {
      ref: `trx:${txid}:native`,
      assetId: 'trx',
      txHash: txid,
      toAddress: to,
      amount,
      blockHeight: blockNumber,
      blockHash: null,
      confirmations: tip - blockNumber + 1n,
      final: true,
    };
  }

  /** Transfer events of the configured contract in one transaction, to watched addresses. */
  async #tokenTransfersIn(
    txid: string,
    watched: Set<string>,
    tip: bigint,
  ): Promise<IncomingTransfer[]> {
    if (!this.#contract || !this.#o.token) return [];
    const events = await this.#list(`/v1/transactions/${txid}/events`, { only_confirmed: 'true' });
    const out: IncomingTransfer[] = [];
    for (const event of events) {
      if (event['event_name'] !== 'Transfer') continue;
      if (
        normalizeTronAddress(str(event['contract_address'], 'contract_address')) !== this.#contract
      )
        continue;
      const result = obj(event['result'], 'result');
      const to = normalizeTronAddress(str(result['to'], 'to'));
      if (!to || !watched.has(to)) continue;
      const amount = BigInt(str(result['value'], 'value'));
      if (amount <= 0n) continue;
      const blockNumber = int(event['block_number'], 'block_number');
      out.push({
        ref: `trx:${txid}:${int(event['event_index'], 'event_index').toString()}`,
        assetId: this.#o.token.assetId,
        txHash: txid,
        toAddress: to,
        amount,
        blockHeight: blockNumber,
        blockHash: null,
        confirmations: tip - blockNumber + 1n,
        final: true,
      });
    }
    return out;
  }

  async #watched(): Promise<Set<string>> {
    const out = new Set<string>();
    for (const a of await this.#o.watchedAddresses()) {
      const v = validateTronAddress(a);
      if (v) out.add(v);
    }
    return out;
  }

  async scanIncoming(cursor: string | null): Promise<ScanResult> {
    if (cursor === null)
      return {
        transfers: [],
        cursor: JSON.stringify({ v: 1, since: Date.now() } satisfies Cursor),
      };
    let parsed: Cursor;
    try {
      const raw = JSON.parse(cursor) as Record<string, unknown>;
      if (raw['v'] !== 1 || typeof raw['since'] !== 'number' || !Number.isSafeInteger(raw['since']))
        throw new Error('bad');
      parsed = { v: 1, since: raw['since'] };
    } catch {
      throw new Error('Invalid TRON cursor');
    }
    const { tip } = await this.#heights();
    const watched = await this.#watched();
    const minTimestamp = String(Math.max(0, parsed.since - (this.#o.overlapMs ?? 60_000)));
    const common = {
      only_confirmed: 'true',
      only_to: 'true',
      min_timestamp: minTimestamp,
      order_by: 'block_timestamp,asc',
      limit: '200',
    };
    const found = new Map<string, IncomingTransfer>();
    let maxTimestamp = parsed.since;

    for (const address of watched) {
      for (const tx of await this.#list(`/v1/accounts/${address}/transactions`, common)) {
        const transfer = this.#nativeTransfer(tx, watched, tip);
        if (transfer) found.set(transfer.ref, transfer);
        maxTimestamp = Math.max(
          maxTimestamp,
          Number(int(tx['block_timestamp'], 'block_timestamp')),
        );
      }
      if (this.#contract) {
        const txids = new Set<string>();
        for (const item of await this.#list(`/v1/accounts/${address}/transactions/trc20`, {
          ...common,
          contract_address: this.#contract,
        })) {
          txids.add(str(item['transaction_id'], 'transaction_id').toLowerCase());
          maxTimestamp = Math.max(
            maxTimestamp,
            Number(int(item['block_timestamp'], 'block_timestamp')),
          );
        }
        for (const txid of txids)
          for (const t of await this.#tokenTransfersIn(txid, watched, tip)) found.set(t.ref, t);
      }
    }
    return {
      transfers: [...found.values()],
      cursor: JSON.stringify({ v: 1, since: maxTimestamp } satisfies Cursor),
    };
  }

  async recheck(ref: string): Promise<TransferCheck> {
    const match = /^trx:([0-9a-f]{64}):(native|[0-9]+)$/.exec(ref);
    if (!match) throw new Error(`Not a TRON transfer ref: ${ref}`);
    const [, txid, which] = match as unknown as [string, string, string];
    const { tip } = await this.#heights();
    if (which === 'native') {
      const tx = obj(
        await this.#post('/walletsolidity/gettransactionbyid', { value: txid }),
        'transaction',
      );
      if (Object.keys(tx).length === 0) return { state: 'missing' };
      const info = obj(
        await this.#post('/walletsolidity/gettransactioninfobyid', { value: txid }),
        'info',
      );
      if (info['blockNumber'] === undefined) return { state: 'missing' };
      const to = obj(
        obj(
          obj(arr(obj(tx['raw_data'], 'raw_data')['contract'], 'contract')[0], 'contract')[
            'parameter'
          ],
          'p',
        )['value'],
        'v',
      )['to_address'];
      const watched = new Set([normalizeTronAddress(str(to, 'to_address')) ?? '']);
      const transfer = this.#nativeTransfer(
        { ...tx, blockNumber: info['blockNumber'] },
        watched,
        tip,
      );
      return transfer ? { state: 'present', transfer } : { state: 'missing' };
    }
    const all = await this.#tokenTransfersIn(txid, new Set(await this.#watched()), tip);
    const transfer = all.find((t) => t.ref === ref);
    return transfer ? { state: 'present', transfer } : { state: 'missing' };
  }
}
