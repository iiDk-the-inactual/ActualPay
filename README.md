# ActualPay

A self-hostable, open-source cryptocurrency payment processor for Bitcoin,
Litecoin, Ethereum, USDT (Ethereum and Tron), TRON and XRP.

> ⚠️ **Under active development: Phase 10 of 13 complete.** Accounts, organizations,
> permissions, API keys, the ledger, watch-only chain adapters, wallets, invoices,
> payment links, the chain-watching worker, signed webhooks and (optional, platform
> custody mode) the signer and withdrawals exist; and a dashboard with hosted checkout exist. Do not use
> with real funds. Even when complete, you are responsible for securing your
> own infrastructure and funds. No software is "100% secure".

## What exists today

- Monorepo with strict TypeScript, ESLint (type-aware), Prettier, Vitest
- Validated configuration that fails fast and refuses unsafe production setups
- PostgreSQL schema and migrations: organizations, assets, ledger, audit log,
  idempotency keys
- A double-entry ledger with database-enforced balancing, immutability,
  overdraft protection and idempotency, tested against real PostgreSQL,
  including concurrency tests
- Accounts with Argon2id passwords, email verification, lockout, password reset,
  TOTP two-factor with recovery codes, and revocable server-side sessions
- Organizations with owner/admin/finance/developer/viewer roles, invitations,
  scoped API keys (rotation, revocation), and an organization audit log
- A Fastify API where every route passes one guard chain (auth → CSRF →
  tenant access → permission → validation → idempotency)
- Watch-only wallets with a first-address confirmation step and race-free deposit-address allocation
- Signed, retried webhooks with SSRF protection, written in the same transaction as the event they announce
- A worker that watches the chains: persistent cursors, reorg handling with a mass-reversal circuit breaker, reconciliation issues
- Invoices, hosted payment views and payment links with an exact-once, reorg-safe payment state machine
- Watch-only adapters for Bitcoin Core, Litecoin Core, Ethereum (+USDT ERC-20),
  TRON (+USDT TRC-20) and the XRP Ledger, with xpub address derivation and
  network-aware address validation
- CI pipeline (including real anvil and litecoind regtest nodes), Dependabot,
  production-dependency license check

## Quick start (development)

Requires Node.js 22.12+, Git, and PostgreSQL 16 (a Redis-compatible server is
optional in development). The commands below use Docker for those; to install them natively instead,
see [Local setup without Docker](docs/local-setup-no-docker.md).

```bash
npm ci
cp .env.example .env      # then generate secrets, see TASKS.md step 3
docker compose up -d
npm run db:migrate
npm run verify            # format, lint, typecheck, unit + integration tests, licenses
npm run admin:create -- --email you@example.com --name "You"
npm run api:dev           # http://127.0.0.1:3000
npm run worker:dev        # in a second terminal: watches the chains
```

## Documentation

- [Architecture and roadmap](docs/architecture.md)
- [Ledger design](docs/ledger.md)
- [Security model: identity and access](docs/security-model.md)
- [Chain integration](docs/chains.md)
- [Wallets and deposit addresses](docs/wallets.md)
- [Invoices and payments](docs/payments.md)
- [Chain watching and the worker](docs/watcher.md)
- [Webhooks](docs/webhooks.md)
- [Withdrawals and the signer](docs/withdrawals.md)
- [Dashboards and hosted checkout](docs/dashboard.md)
- [Email notifications and alerts](docs/notifications.md)
- [Local setup without Docker](docs/local-setup-no-docker.md)
- [Local verification checklist](TASKS.md)
- [Security policy](SECURITY.md)

## License

[MIT](LICENSE). Third-party dependencies keep their own licenses; production
dependencies are restricted to permissive licenses by `npm run licenses:check`.
