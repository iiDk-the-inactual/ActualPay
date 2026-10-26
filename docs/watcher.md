# Chain watching and the worker (Phase 6)

The worker (`npm run worker:start`) is what turns on-chain transfers into
payments. Nothing else feeds payments in. It runs the chain adapters from
docs/chains.md against the operator's nodes and hands every transfer it sees to
`recordObservation` (docs/payments.md).

```
npm run worker:start     run forever; SIGTERM/SIGINT finish the current cycle
npm run worker:once      run one cycle and print what happened
npm run worker:status    print cursors, leases and open reconciliation issues
```

Run it as its own process, next to the API. Run two for availability: leases
make each task run in one place at a time.

## The core safety rule

**An address is never handed to a payer unless something is watching it.**

- _Cursor first._ `chain_cursors` has a row for a chain only once a worker has
  started scanning it, at the then-current tip. Invoice creation refuses
  (`UPSTREAM_UNAVAILABLE`) until that row exists, so no invoice can exist
  before the point from which scanning starts. History is never imported.
- _Range first (Bitcoin/Litecoin)._ The node only reports payments to
  addresses it has been told about. The worker imports
  `[0, next_index + 100]` for every confirmed wallet, archived ones included,
  and records the reach in `wallets.watched_through`. Address allocation
  refuses to go past it. If the worker falls behind, issuing stops (safe)
  rather than risking an unwatched address.
- _Account chains (Ethereum, Tron)_ watch every deposit address ever issued,
  including expired invoices and archived wallets: customers pay late. The
  adapters read the tip before loading the address set, so an address issued
  during a scan cannot be paid inside blocks that scan skips.
- _XRPL_ watches one account (`XRPL_DEPOSIT_ACCOUNT`); a wallet can only be
  registered for exactly that account.

## One cycle

Per chain: (UTXO) extend the imported range → scan. Then, once: recheck
unsettled payments → expire invoices → reconcile (every 5 minutes).

**Scan.** Reads transfers since the cursor and records each one. The cursor
moves forward only after every transfer up to it has been recorded, so a crash
or error can cause re-processing (harmless, everything is idempotent) but
never a gap. While a node reports it is still syncing, nothing is scanned or
finalised. A transient failure (database or node) aborts the scan and keeps the
cursor. A transfer that _contradicts_ what is recorded (same reference,
different amount) cannot be a real chain event; it raises a critical issue and
is skipped, so one bad transfer cannot freeze a chain.

**Recheck.** Pending payments, and payments confirmed in the last 6 hours, are
re-read from the chain. Still there: update confirmations, confirm if now
final. Gone (reorged, replaced): reverse it, with a ledger reversal if it had
been credited. A node that is unsynced or unreachable never causes a reversal.

**Circuit breaker.** If one cycle would reverse **5 or more** payments on one
chain, none are reversed and a critical `mass_reversal_suspected` issue is
raised. That pattern means "the node is wrong" (restored from an old snapshot,
wrong network), not "the chain reorganised". Genuine reorgs rarely drop that
many of your payments. When the node recovers the issue clears itself.

**Reversal blocked.** If a confirmed deposit disappears after the merchant
already withdrew the money, the books cannot reverse it. The payment stays
confirmed and a critical `reversal_blocked` issue is raised. This is a real
loss that an operator books explicitly (docs/ledger.md).

**Expire.** Moves unpaid invoices past their time to `expired`. Payments in
flight keep them `processing`.

## Reconciliation issues

`reconciliation_issues` is the list of things a human must look at. Repeats bump
a counter instead of piling up, and conditions that detection can prove are
gone resolve themselves, so "open" always means "needs attention now".

| Kind                      | Severity | Meaning                                                             |
| ------------------------- | -------- | ------------------------------------------------------------------- |
| `ledger_integrity`        | critical | the books failed their own check: stop moving money                 |
| `invoice_totals_mismatch` | critical | an invoice's cached totals differ from its payments                 |
| `observation_rejected`    | critical | a transfer contradicts what is recorded                             |
| `mass_reversal_suspected` | critical | many payments look missing at once: check the node first            |
| `reversal_blocked`        | critical | a deposit vanished after the money was spent                        |
| `watcher_stale`           | critical | nothing scanned a chain for 15 minutes: payments are not being seen |
| `payment_stuck_pending`   | warning  | unconfirmed for more than 24 hours                                  |
| `expiry_lagging`          | warning  | invoices past expiry still show as unpaid: is the worker running?   |

Operators resolve an issue with a note (audited); the dashboard for this is
Phase 9, `resolveIssue` is ready. Comparing custody with actual on-chain
balances needs the signer and sweep accounting and arrives with Phase 8.

## Leases and the job system

`job_leases` holds one named lease per recurring task. A worker claims it with a
single `UPDATE … WHERE locked_until < now()`, runs, and releases; a crashed
worker's lease simply expires (default 2 minutes). Tasks are idempotent, so
running again after an expiry is harmless; the lease only prevents duplicate
work. pg-boss was considered (docs/architecture.md) but everything here is
poll-driven and idempotent, with no job that must be enqueued atomically with a
business change, so a table is enough and avoids a dependency that manages its
own schema. Webhook delivery (Phase 7) is an outbox, also in PostgreSQL.

## Settings

`WORKER_SCAN_INTERVAL_SECONDS` (default 15) sets the cycle interval. Confirmation
depth is per chain (`BITCOIN_CONFIRMATIONS`, `LITECOIN_CONFIRMATIONS`; Ethereum
uses the node's `finalized` block; XRPL validated ledgers; TRON solidified
blocks).

## Tested against real nodes

`tests/integration/watcher-evm.test.ts` (Anvil) and `watcher-utxo.test.ts`
(Bitcoin Core regtest) run the whole path with real transactions: wallet,
invoice, payment, mempool sighting, confirmations, exact credit, and a
reorganised-away pending payment. They are skipped unless `EVM_TEST_RPC_URL` /
`UTXO_REGTEST_URL` are set. Reorg handling, node failure, unsynced nodes,
contradictory transfers, the breaker and reconciliation are tested against a
controllable fake chain.

## Not covered (yet)

- ETH and TRX sent by smart contracts (internal transfers) are not seen by the
  adapters (docs/chains.md); only on-chain balance reconciliation will reveal
  them (Phase 8).
- Alerting: issues are rows, not pages. Wire `worker:status` or the issue list
  to your monitoring (see MANUAL-STEPS.md).
