# Manual steps (running draft)

This file is rewritten in full at the end of the build. Entries are added per
phase so nothing is forgotten.

## From Phase 5

- **Fiat pricing.** Invoices are in crypto. If merchants price in dollars or
  euros you must add a price source (and decide rounding, staleness and the
  quote-lock window). Not built: it is a business and legal decision.

## From Phase 6

- **Run the worker.** `npm run worker:start` must be running next to the API,
  or invoices are refused. Run it under a process supervisor (systemd, or a
  container restart policy) and run two for availability.
- **Nodes.** The worker needs your own Bitcoin Core (v30+) and/or Litecoin Core
  (0.21.x) with a funded-wallet-free, watch-only setup, an Ethereum JSON-RPC
  endpoint, a TronGrid-compatible API and/or an XRPL server, and `*_CONFIRMATIONS`
  chosen to match the amounts you accept.
- **Alerting.** Open `reconciliation_issues` rows are the alarm. Point your
  monitoring at `npm run worker:status` (or the table) and page on any
  `critical` issue.
- **A `reversal_blocked` issue means a real loss.** Decide the accounting
  (docs/ledger.md) before anyone resolves it.
