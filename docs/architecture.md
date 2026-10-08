# Architecture

This document records the design decisions made before implementation and
the reasons behind them. Later phases extend it; they do not silently change it.

## Scope

ActualPay is a self-hosted payment processor for public blockchains. Version 1
supports these assets (an _asset_ is a currency on a specific network):

| Asset id     | Chain    | Base unit  | Decimals | Fees paid in |
| ------------ | -------- | ---------- | -------- | ------------ |
| `btc`        | Bitcoin  | satoshi    | 8        | btc          |
| `ltc`        | Litecoin | litoshi    | 8        | ltc          |
| `eth`        | Ethereum | wei        | 18       | eth          |
| `usdt-erc20` | Ethereum | micro-USDT | 6        | eth          |
| `trx`        | Tron     | sun        | 6        | trx          |
| `usdt-trc20` | Tron     | micro-USDT | 6        | trx          |
| `xrp`        | XRPL     | drop       | 6        | xrp          |

USDT is deliberately two assets. Sending USDT on the wrong network can be
unrecoverable, so the network is part of every invoice, address and balance.
Legacy USDT networks (Omni, BCH SLP, Kusama, EOS, Algorand) are not supported.

## Chain models and their consequences

**Bitcoin / Litecoin (UTXO).** Receiving uses a watch-only extended public key
(BIP84). The API and worker can derive a fresh address per invoice but cannot
spend. Detection uses the operator's own
`bitcoind`/`litecoind` with a watch-only wallet (descriptor wallet on Bitcoin
Core v30+, legacy watch-only wallet on Litecoin Core, whose release builds
lack descriptor support; see docs/chains.md). Reorgs happen, so confirmation depth is configurable and
reorged deposits are reversed with ledger reversal journals.

**Ethereum + ERC-20 (accounts).** Per-invoice HD addresses. The watcher reads
native transfers from blocks and USDT `Transfer` logs, and treats the
`finalized` block tag as final. Token deposit addresses hold no ETH, so
sweeping requires a gas top-up first; this cost is booked as a network fee.

**Tron + TRC-20.** Same shape as Ethereum. Fees are paid in energy/bandwidth
(or burned TRX), booked in `trx`.

**XRPL.** One receiving account per deployment, invoices distinguished by
destination tag. The account sets `RequireDest` so untagged payments are
rejected by the ledger itself. Validated ledgers are final (no reorgs).
Deposits credit `meta.delivered_amount`, **never** `Amount`, to defeat
partial-payment attacks. Reserves are read live (`server_info`), not hardcoded.

## Custody model

- **Watch-only side** (API, worker): xpubs, receiving addresses, the XRPL
  receiving address. Compromise leaks payment privacy, not funds.
- **Signer** (separate process, Phase 8): holds hot keys, encrypted at rest.
  It signs only withdrawals that are approved in the database and re-verifies
  them itself. The interface is designed so an HSM, hardware wallet or external
  signing service can replace it.
- **Cold storage**: operators sweep excess hot-wallet funds to addresses whose
  keys never touch the server. ActualPay records these as ordinary transfers.

## Correctness mechanisms

| Risk                             | Mechanism                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| Floating-point money errors      | `bigint` base units everywhere; `numeric(78,0)` in PostgreSQL; lint bans `parseFloat`/`toFixed` |
| Double-crediting a deposit       | Unique `ledger_journals.external_ref` derived from the on-chain output                          |
| Concurrent withdrawals overspend | Row lock on the balance account + `CHECK (balance >= 0)`                                        |
| Unbalanced books                 | Deferred constraint trigger verifies debits = credits per asset at COMMIT                       |
| Edited/deleted history           | Triggers make journals, entries and audit log append-only (incl. TRUNCATE)                      |
| Cross-tenant fund movement       | Ledger refuses journals touching another organization's accounts                                |
| Lost broadcast response          | Signed tx and txid persisted _before_ broadcast; reconcile by txid (Phase 8)                    |
| Job lost between DB and queue    | PostgreSQL-backed jobs/outbox committed with the business change (Phase 6)                      |

## Technology choices

| Concern      | Choice                            | Why                                                                                                                                                                     |
| ------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime      | Node.js 22 LTS, TypeScript strict | Requested; strict mode + `noUncheckedIndexedAccess` for safety                                                                                                          |
| Database     | PostgreSQL 16+                    | Transactions, row locks, CHECK and deferred constraints; `NULLS NOT DISTINCT` needs 15+                                                                                 |
| Query layer  | Kysely (MIT)                      | Typed SQL builder with explicit `FOR UPDATE`; no ORM magic around money                                                                                                 |
| Migrations   | Kysely migrator, raw SQL          | Reviewers see the exact DDL; advisory lock prevents concurrent runs                                                                                                     |
| Validation   | Zod (MIT)                         | Runtime validation for config and (later) every API input                                                                                                               |
| Logging      | Pino (MIT)                        | Structured JSON with redaction; bigints emitted as exact strings                                                                                                        |
| Cache/limits | Valkey (BSD-3) / Redis-compatible | Rate limits and cache only, never the source of truth                                                                                                                   |
| Jobs         | pg-boss (MIT), Phase 6            | Jobs live in PostgreSQL, so enqueueing is part of the same transaction as the change that caused it. BullMQ was considered and rejected for money paths for this reason |
| HTTP         | Fastify (MIT), Phase 2            | Schema-first, fast, mature, good TypeScript support                                                                                                                     |
| Tests        | Vitest (MIT)                      | Unit + real-PostgreSQL integration tests                                                                                                                                |

Production dependency licenses are enforced by `npm run licenses:check`.

## Repository layout

```
packages/
  shared/    money arithmetic, asset registry, errors, logger
  config/    validated configuration (+ *_FILE secret support)
  database/  Kysely client, schema types, migrations, CLI
  ledger/    double-entry posting, named postings, integrity checks
  auth/      passwords, sessions, MFA, RBAC, organizations, API keys
  audit/     append-only audit writer with metadata sanitising
  email/     mailer abstraction, SMTP transport, security emails
  chains/    watch-only chain adapters, address derivation and validation
apps/
  api/       Fastify HTTP API (routes, guard chain, idempotency), CLIs
             (admin:create, chain:probe, chain:watch)
             (worker, signer, dashboard arrive in later phases)
tests/       unit and integration suites
docs/        design and operations documentation
```

## Roadmap

1. Foundation: repo, config, database, migrations, ledger core ← **done**
2. Auth, users, organizations, RBAC, API keys, HTTP API skeleton, idempotency middleware ← **done** (see docs/security-model.md)
3. Chain adapters (watch-only): BTC, LTC, ETH/ERC-20, TRX/TRC-20, XRPL ← **done** (see docs/chains.md)
4. Wallets and address derivation
5. Invoices, payment links, payment state machine
6. Chain watchers, confirmations, reorg handling, reconciliation, job system
7. Webhooks
8. Signer service and withdrawals
9. Merchant and admin dashboards
10. Email and optional forwarding
11. Documentation and OpenAPI
12. Security hardening, threat model, security test suite
13. Docker images and production deployment
