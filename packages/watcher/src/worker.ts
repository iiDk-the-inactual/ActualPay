/**
 * The worker cycle: everything that keeps payments flowing, run under leases so
 * several workers can run side by side.
 *
 *   per chain:  (UTXO) extend the imported address range → scan for transfers
 *   then:       recheck unsettled payments → expire invoices → reconcile
 */
import { randomUUID } from 'node:crypto';
import { BitcoinCoreAdapter, type OutgoingChain, type WatchOnlyAdapter } from '@actualpay/chains';
import type { Db } from '@actualpay/database';
import { expireInvoices } from '@actualpay/payments';
import {
  broadcastSigned,
  expireApprovals,
  trackBroadcasts,
  type OutgoingSummary,
} from '@actualpay/withdrawals';
import {
  deliverDue,
  type DeliverySummary,
  type Resolver,
  type UrlPolicy,
} from '@actualpay/webhooks';
import type { SecretBox } from '@actualpay/auth';
import type { ChainFamily, Logger } from '@actualpay/shared';
import { runLeased } from './leases';
import { reconcileOnce } from './reconcile';
import { recheckPayments, type RecheckSummary } from './recheck';
import { scanChain, type ScanOutcome } from './scan';
import { syncUtxoWatch } from './watchsync';

export interface WorkerDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly adapters: ReadonlyMap<ChainFamily, WatchOnlyAdapter>;
  /** Identifies this worker in lease records. */
  readonly ownerId?: string;
  readonly leaseSeconds?: number;
  /** Nodes for broadcasting and following withdrawals; omitted means this worker does not handle them. */
  readonly outgoing?: ReadonlyMap<ChainFamily, OutgoingChain>;
  /** Webhook delivery; omitted means webhooks are not sent by this worker. */
  readonly webhooks?: {
    readonly box: SecretBox;
    readonly policy: UrlPolicy;
    readonly resolver?: Resolver;
  };
}

export interface CycleResult {
  scans: Record<string, ScanOutcome | { kind: 'lease_held' }>;
  recheck?: RecheckSummary | { kind: 'lease_held' };
  expired?: number | { kind: 'lease_held' };
  reconciled?: { problems: number } | { kind: 'lease_held' };
  webhooks?: DeliverySummary | { kind: 'lease_held' };
  withdrawals?:
    { expired: number; broadcast: number; tracked: OutgoingSummary } | { kind: 'lease_held' };
}

export async function runCycle(
  deps: WorkerDeps,
  options: { reconcile?: boolean; now?: Date } = {},
): Promise<CycleResult> {
  const { db, logger } = deps;
  const owner = deps.ownerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const ttlSeconds = deps.leaseSeconds ?? 120;
  const lease = (name: string) => ({ name, owner, ttlSeconds });
  const result: CycleResult = { scans: {} };

  for (const adapter of deps.adapters.values()) {
    const key = `${adapter.chain}:${adapter.network}`;
    try {
      if (adapter instanceof BitcoinCoreAdapter) {
        await runLeased(db, lease(`watchsync:${key}`), () =>
          syncUtxoWatch({ db, logger, adapter }),
        );
      }
      const run = await runLeased(db, lease(`scan:${key}`), (heartbeat) =>
        scanChain({ db, logger, adapter, heartbeat, ...(options.now ? { now: options.now } : {}) }),
      );
      result.scans[key] = run.ran ? run.value : { kind: 'lease_held' };
    } catch (error) {
      logger.error({ chain: adapter.chain, err: error }, 'chain task failed');
      result.scans[key] = {
        kind: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const recheck = await runLeased(db, lease('recheck'), () =>
    recheckPayments({
      db,
      logger,
      adapters: deps.adapters,
      ...(options.now ? { now: options.now } : {}),
    }),
  );
  result.recheck = recheck.ran ? recheck.value : { kind: 'lease_held' };

  const expire = await runLeased(db, lease('expire-invoices'), () =>
    expireInvoices(db, options.now ? { now: options.now } : {}),
  );
  result.expired = expire.ran ? expire.value : { kind: 'lease_held' };

  if (deps.outgoing) {
    const outgoing = deps.outgoing;
    const run = await runLeased(db, lease('withdrawals'), async () => {
      const expired = await expireApprovals(db, options.now ? { now: options.now } : {});
      const sent = await broadcastSigned({
        db,
        outgoing,
        logger,
        ...(options.now ? { now: options.now } : {}),
      });
      const tracked = await trackBroadcasts({
        db,
        outgoing,
        logger,
        ...(options.now ? { now: options.now } : {}),
      });
      return { expired, broadcast: sent.broadcast, tracked };
    });
    result.withdrawals = run.ran ? run.value : { kind: 'lease_held' };
  }

  if (deps.webhooks) {
    const { box, policy, resolver } = deps.webhooks;
    const sent = await runLeased(db, lease('webhooks'), () =>
      deliverDue({
        db,
        box,
        logger,
        policy,
        ...(resolver ? { resolver } : {}),
        ...(options.now ? { now: options.now } : {}),
      }),
    );
    result.webhooks = sent.ran ? sent.value : { kind: 'lease_held' };
  }

  if (options.reconcile !== false) {
    const reconcile = await runLeased(db, lease('reconcile'), () =>
      reconcileOnce({ db, logger, ...(options.now ? { now: options.now } : {}) }),
    );
    result.reconciled = reconcile.ran ? reconcile.value : { kind: 'lease_held' };
  }
  return result;
}

export interface RunningWorker {
  stop(): Promise<void>;
}

/** Run cycles forever (until `stop`). Errors are logged and never kill the loop. */
export function startWorker(
  deps: WorkerDeps & { intervalMs: number; reconcileEveryMs?: number },
): RunningWorker {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let lastReconcile = 0;
  const reconcileEvery = deps.reconcileEveryMs ?? 300_000;

  const tick = async (): Promise<void> => {
    try {
      const due = Date.now() - lastReconcile >= reconcileEvery;
      await runCycle(deps, { reconcile: due });
      if (due) lastReconcile = Date.now();
    } catch (error) {
      deps.logger.error({ err: error }, 'worker cycle failed');
    }
    if (!stopped) {
      timer = setTimeout(() => {
        inFlight = tick();
      }, deps.intervalMs);
    }
  };
  inFlight = tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
