# ActualPay

A self-hostable, open-source cryptocurrency payment processor for Bitcoin,
Litecoin, Ethereum, USDT (Ethereum and Tron), TRON and XRP.

> ⚠️ **Under active development: Phase 3 of 13 complete.** Accounts, organizations,
> permissions, API keys, the ledger and watch-only chain adapters exist; invoices,
> wallets and withdrawals do not yet. Do not use
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
- Watch-only adapters for Bitcoin Core, Litecoin Core, Ethereum (+USDT ERC-20),
  TRON (+USDT TRC-20) and the XRP Ledger, with xpub address derivation and
  network-aware address validation
- CI pipeline (including real anvil and litecoind regtest nodes), Dependabot,
  production-dependency license check

## Quick start (development)

Requires Node.js 22.12+, Docker, and Git.

```bash
npm ci
cp .env.example .env      # then generate secrets, see TASKS.md step 3
docker compose up -d
npm run db:migrate
npm run verify            # format, lint, typecheck, unit + integration tests, licenses
npm run admin:create -- --email you@example.com --name "You"
npm run api:dev           # http://127.0.0.1:3000
```

## Documentation

- [Architecture and roadmap](docs/architecture.md)
- [Ledger design](docs/ledger.md)
- [Security model: identity and access](docs/security-model.md)
- [Chain integration](docs/chains.md)
- [Local verification checklist](TASKS.md)
- [Security policy](SECURITY.md)

## License

[MIT](LICENSE). Third-party dependencies keep their own licenses; production
dependencies are restricted to permissive licenses by `npm run licenses:check`.
