/** A controllable in-memory chain for watcher tests: reorgs, unsynced nodes, failures. */
import type {
  ChainStatus,
  IncomingTransfer,
  ScanResult,
  TransferCheck,
  WatchOnlyAdapter,
} from '@actualpay/chains';
import type { AssetId, ChainFamily, NetworkMode } from '@actualpay/shared';

export class FakeAdapter implements WatchOnlyAdapter {
  readonly chain: ChainFamily;
  readonly network: NetworkMode = 'testnet';
  readonly assets: readonly AssetId[];
  tip = 100n;
  synced = true;
  /** When set, the next call to the named method throws once. */
  failNext: 'status' | 'scanIncoming' | 'recheck' | null = null;
  readonly transfers = new Map<string, IncomingTransfer>();
  scans = 0;

  constructor(chain: ChainFamily = 'ethereum', assets: readonly AssetId[] = ['eth']) {
    this.chain = chain;
    this.assets = assets;
  }

  add(transfer: IncomingTransfer): void {
    this.transfers.set(transfer.ref, transfer);
  }

  /** The chain forgets this transfer (reorged out). */
  drop(ref: string): void {
    this.transfers.delete(ref);
  }

  #maybeFail(method: 'status' | 'scanIncoming' | 'recheck'): void {
    if (this.failNext === method) {
      this.failNext = null;
      throw new Error(`injected ${method} failure`);
    }
  }

  status(): Promise<ChainStatus> {
    this.#maybeFail('status');
    return Promise.resolve({
      chain: this.chain,
      network: this.network,
      tipHeight: this.tip,
      finalHeight: this.tip - 10n,
      synced: this.synced,
    });
  }

  scanIncoming(cursor: string | null): Promise<ScanResult> {
    this.#maybeFail('scanIncoming');
    this.scans += 1;
    if (cursor === null) return Promise.resolve({ transfers: [], cursor: this.tip.toString() });
    return Promise.resolve({
      transfers: [...this.transfers.values()],
      cursor: this.tip.toString(),
    });
  }

  recheck(ref: string): Promise<TransferCheck> {
    this.#maybeFail('recheck');
    const transfer = this.transfers.get(ref);
    return Promise.resolve(transfer ? { state: 'present', transfer } : { state: 'missing' });
  }
}
