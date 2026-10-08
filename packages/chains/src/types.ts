/**
 * Chain-agnostic, watch-only interface.
 *
 * Everything above this package (invoices, ledger, workers) talks to chains
 * only through these types. Nothing here can move funds: signing and
 * broadcasting live in the separate signer (Phase 8).
 */
import type { AssetId, ChainFamily, NetworkMode } from '@actualpay/shared';

export interface ChainStatus {
  readonly chain: ChainFamily;
  readonly network: NetworkMode;
  /** Highest block/ledger the node knows. */
  readonly tipHeight: bigint;
  /** Highest height the adapter treats as final (see finality rules per chain). */
  readonly finalHeight: bigint;
  /** False while the node is still syncing; deposits must not be finalised then. */
  readonly synced: boolean;
}

/** One incoming on-chain credit to an address we watch. */
export interface IncomingTransfer {
  /**
   * Globally unique, stable reference for this specific credit, used as the
   * ledger idempotency key (docs/ledger.md): `btc:<txid>:<vout>`,
   * `eth:<tx>:native`, `eth:<tx>:<logIndex>`, `trx:<tx>:<n>`, `xrp:<tx>`.
   */
  readonly ref: string;
  readonly assetId: AssetId;
  readonly txHash: string;
  readonly toAddress: string;
  /** XRPL destination tag; undefined when the payment carried none. */
  readonly destinationTag?: number;
  /** Exact amount in base units. */
  readonly amount: bigint;
  /** Null while unconfirmed (mempool). */
  readonly blockHeight: bigint | null;
  readonly blockHash: string | null;
  readonly confirmations: bigint;
  /** True once the chain's finality rule is met; only then may it be credited. */
  readonly final: boolean;
}

export interface ScanResult {
  readonly transfers: readonly IncomingTransfer[];
  /** Opaque, chain-specific resume point. Persist it only after processing `transfers`. */
  readonly cursor: string;
}

/** Re-verification of a previously seen transfer (reorg / double-spend check). */
export type TransferCheck =
  | { readonly state: 'present'; readonly transfer: IncomingTransfer }
  /** No longer on the best chain (reorged out, replaced, or never confirmed). */
  | { readonly state: 'missing' };

export interface WatchOnlyAdapter {
  readonly chain: ChainFamily;
  readonly network: NetworkMode;
  readonly assets: readonly AssetId[];
  status(): Promise<ChainStatus>;
  /**
   * Incoming transfers since `cursor` (null = start at the current tip, i.e.
   * do not import history). Must be safe to call repeatedly with the same
   * cursor: results are deterministic and refs are stable.
   */
  scanIncoming(cursor: string | null): Promise<ScanResult>;
  /** Look a transfer up again by ref to confirm it is still valid. */
  recheck(ref: string): Promise<TransferCheck>;
}
