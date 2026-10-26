# ActualPay: Local Verification Tasks

This file is the hand-off checklist for verifying ActualPay on a real machine.
It is written to be executed by Claude Code (or a human) from top to bottom.
Each phase appends a new section; earlier sections stay as regression checks.

## Instructions for Claude Code

- Work through the sections in order. Tick each box (`- [x]`) as it passes.
- Run commands from the repository root. Commands are shown for
  **PowerShell on Windows** first, with bash equivalents where they differ.
- When a step fails: diagnose and fix the **root cause** in the code or the
  environment, then re-run the step _and_ `npm run verify`. Record what you
  changed under "Findings log" at the bottom.
- **Never** do any of the following to make something pass:
  - edit an already-applied migration (add a new migration instead),
  - weaken a database constraint or trigger, or delete a failing test,
  - change amount handling to use `number`/floats,
  - point integration tests at a database whose name does not end in `_test`,
  - use mainnet networks or real funds. Testnets only.
- If a fix would change architecture or a security property, stop and write
  the question under "Open questions" instead of deciding alone.

## Phase status

| Phase | Scope                                           | Status                                      |
| ----- | ----------------------------------------------- | ------------------------------------------- |
| 1     | Repo, config, database, migrations, ledger core | Delivered, needs local verification (below) |
| 2     | Auth, organizations, RBAC, API keys, HTTP API   | Delivered, needs local verification (below) |
| 3     | Watch-only chain adapters                       | Delivered, needs local verification (below) |
| 4     | Wallets and address derivation                  | Delivered, needs local verification (below) |
| 5     | Invoices, payment links, payment state machine  | Delivered, needs local verification (below) |
| 6     | Chain watchers, reorgs, reconciliation, worker  | Delivered, needs local verification (below) |
| 7     | Webhooks                                        | Delivered, needs local verification (below) |
| 8–13  | See docs/architecture.md                        | Not started                                 |

---

## Phase 1: Foundation

### 1. Prerequisites

- [x] Node.js **22.12 or newer**: `node -v`
- [x] npm 10+: `npm -v`
- [ ] Docker Desktop running (on Windows, the **WSL 2** backend): `docker version` shows both Client and Server
- [ ] Docker Compose v2: `docker compose version`
- [ ] Git configured to keep LF endings for this repo (enforced by `.gitattributes`; if the repo was cloned before that file existed, run `git rm --cached -r . ; git reset --hard`)
- [ ] Nothing else is listening on ports 5432 or 6379. A locally installed PostgreSQL service is the usual culprit on Windows.
  - PowerShell: `Get-NetTCPConnection -LocalPort 5432,6379 -ErrorAction SilentlyContinue`
  - bash: `lsof -i :5432 -i :6379`
  - If occupied: stop that service, or change the host ports in `docker-compose.yml` **and** the URLs in `.env`.

### 2. Install dependencies

- [x] `npm ci` completes with no errors (uses the committed `package-lock.json`)
- [x] `npm audit --omit=dev` reports no high or critical vulnerabilities. If it does, record them under Findings; do not run `npm audit fix --force`.

### 3. Create `.env`

- [x] Copy the template:
  - PowerShell: `Copy-Item .env.example .env`
  - bash: `cp .env.example .env`
- [x] Generate secrets (works on any OS without openssl):
  - `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` → paste as `SESSION_SECRET`
  - `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` → paste as `ENCRYPTION_KEY`
- [x] Leave `APP_ENV=development`, `NETWORK_MODE=testnet`, `ENABLED_ASSETS=xrp`.
- [x] Confirm `.env` is git-ignored: `git check-ignore .env` prints `.env`.
- [x] Confirm the config loads:
      `node --env-file=.env --import tsx -e "import('@actualpay/config').then(m => console.log(m.describeConfig(m.loadConfig())))"`
      Expected output: an object with `env: 'development'`, `enabledAssets: ['xrp']`, and **no passwords** anywhere in it.
- [x] Negative check: temporarily set `ENCRYPTION_KEY=short` and re-run the command above. It must fail with `ENCRYPTION_KEY: must be exactly 32 random bytes` and must **not** print the value `short`. Restore the real key afterwards.

### 4. Start local services

- [ ] `docker compose up -d`
- [ ] `docker compose ps` shows `postgres` and `valkey` as **healthy** (wait up to ~30 s).
- [ ] The test database exists:
      `docker compose exec postgres psql -U actualpay -d actualpay_dev -c "\l"` lists `actualpay_test`.
  - The init script only runs when the volume is first created. If `actualpay_test` is missing, create it:
    `docker compose exec postgres psql -U actualpay -d actualpay_dev -c "CREATE DATABASE actualpay_test OWNER actualpay;"`
- [ ] Valkey accepts the password: `docker compose exec valkey valkey-cli -a actualpay-dev-only ping` → `PONG`

### 5. Migrate the development database

- [x] `npm run db:status` lists every migration as `PENDING` and exits with code 1 (that is expected before the first migrate).
- [x] `npm run db:migrate` prints `applied:` for each migration (`0001_foundation` … the latest), then `Asset registry verified.`
- [x] Running `npm run db:migrate` again prints `Database is up to date.`
- [x] `npm run db:status` shows every migration as `applied` and exits with code 0.
- [x] Assets are seeded with the right decimals:
      `docker compose exec postgres psql -U actualpay -d actualpay_dev -c "SELECT id, chain, decimals, fee_asset_id FROM assets ORDER BY id;"`
      Expected: btc 8, eth 18, ltc 8, trx 6, usdt-erc20 6 (fee eth), usdt-trc20 6 (fee trx), xrp 6.

### 6. Full verification suite

- [x] `npm run verify` passes. It runs, in order:
  - `format:check` (Prettier)
  - `lint` (type-aware ESLint)
  - `typecheck`
  - `npm test`: all unit tests pass
  - `test:integration`: all integration tests pass, against `actualpay_test`
  - (Exact counts for the current phase are listed in that phase's section.)
  - `licenses:check`: "All production dependency licenses are allowed."
- [x] Run the integration suite **three times in a row**: `npm run test:integration`. The concurrency tests must pass every time. Any flake is a real bug: record it.

### 7. Manual database guarantees

Run each statement against the dev database
(`docker compose exec postgres psql -U actualpay -d actualpay_dev`). Every
one of them **must fail** with the error shown:

- [x] `UPDATE assets SET decimals = 2 WHERE id = 'btc';` → `protocol fields of asset btc are immutable`
- [x] `DELETE FROM assets WHERE id = 'btc';` → `table assets is append-only`
- [x] `TRUNCATE ledger_entries;` → `append-only`
- [x] `INSERT INTO ledger_journals (external_ref, kind, content_hash) VALUES ('manual:1', 'adjustment', repeat('a', 64));` → `has 0 entries; at least 2 required`
- [x] `INSERT INTO audit_log (actor_type, action) VALUES ('user', 'user.login.succeeded');` → violates `audit_log_actor`

### 8. CI

- [ ] Push to a GitHub repository (private is fine). The **CI** workflow passes on the first run.
- [ ] Dependabot is enabled for the repository (Settings → Code security).
- [ ] GitHub private vulnerability reporting is enabled, and `SECURITY.md` is updated to say so (the maintainer must do this; it is intentionally not pre-filled).

### 9. Cleanup check

- [ ] `docker compose down` stops services; `docker compose up -d` restores them with data intact (`npm run db:status` still shows all applied).
- [ ] To fully reset local data: `docker compose down -v` (deletes volumes), then repeat steps 4–5.

---

## Phase 2: Identity, organizations, API

Prerequisite: Phase 1 sections above pass. Phase 2 adds migration
`0004_identity`, the API server (`apps/api`), and new configuration.

### 1. Update configuration

- [x] Compare `.env` with `.env.example` and add every key that is missing. New in Phase 2:
      `API_HOST`, `API_PORT`, `CORS_ALLOWED_ORIGINS`, `SESSION_IDLE_MINUTES`,
      `SESSION_ABSOLUTE_HOURS`, `LOGIN_MAX_FAILURES`, `LOGIN_LOCK_MINUTES`,
      `RATE_LIMIT_AUTH_PER_MINUTE`, `RATE_LIMIT_API_PER_MINUTE`, `TEST_REDIS_URL`.
      The defaults in `.env.example` are correct for local development.
- [x] `TEST_REDIS_URL` ends in `/15`. The integration tests **flush** that logical database, and refuse to run against any other.
- [x] `npm ci` (new dependencies: fastify and plugins, `@node-rs/argon2`, `otpauth`, `ioredis`, `nodemailer`).
  - `@node-rs/argon2` ships prebuilt Windows binaries. If install fails with a node-gyp or native-module error, record the exact message under Findings; do **not** swap in a different hashing library.

### 2. Migrate

- [x] `npm run db:migrate` prints `applied: 0004_identity`.
- [x] `npm run db:status` shows 4 migrations, all `applied`.

### 3. Full verification

- [ ] `docker compose up -d` and both services are healthy (Valkey is now used by tests).
- [ ] `npm run verify` passes with **63 unit tests** and **70 integration tests**.
  - `tests/integration/api-ratelimit.test.ts` must report **4 passed, 0 skipped**. If 2 are skipped, `TEST_REDIS_URL` is not set.
- [x] Run `npm run test:integration` three times in a row. All passes, no flakes.

### 4. Create the first administrator

- [ ] Interactive (hidden prompt): `npm run admin:create -- --email you@example.com --name "Your Name"`
  - Confirm the typed password is **not echoed** in PowerShell / Windows Terminal. If it is echoed, record it under Findings (the prompt implementation is in `apps/api/src/cli/admin-create.ts`).
- [x] Non-interactive path works too (use a different email):
  - PowerShell: `$env:ACTUALPAY_ADMIN_PASSWORD = 'a long test passphrase'; npm run admin:create -- --email second@example.com; Remove-Item Env:ACTUALPAY_ADMIN_PASSWORD`
  - bash: `ACTUALPAY_ADMIN_PASSWORD='a long test passphrase' npm run admin:create -- --email second@example.com`
- [x] Running the same command again fails with `A user with this email already exists.` and exit code 1.

### 5. Run the API

- [x] In a separate terminal: `npm run api:dev`. The log shows `Server listening at http://127.0.0.1:3000` and contains no secrets (the config summary shows hosts only).
- [x] `curl.exe http://127.0.0.1:3000/health/ready` (PowerShell: use `curl.exe`, not the `curl` alias) returns `{"status":"ready","checks":{"database":"ok","redis":"ok"}}`.

### 6. Smoke test against the running API

Set the admin credentials for the script:

- PowerShell: `$env:SMOKE_EMAIL = 'you@example.com'; $env:SMOKE_PASSWORD = '<your password>'`
- bash: `export SMOKE_EMAIL=you@example.com SMOKE_PASSWORD='<your password>'`

- [x] `npm run smoke:api -- --rate-limit` ends with `All smoke checks passed.` (16 checks, including CSRF rejection, API key scope/revocation, audit log, logout, and a 429 from the auth rate limit).
  - Rate-limit counters persist for one minute. If you re-run within a minute, the login step itself may get a 429; wait a minute first.
- [ ] **Real authenticator app.** Run `npm run smoke:api -- --mfa` and follow the prompts. Use a phone app such as Google Authenticator, Microsoft Authenticator, Aegis or 1Password, and enter the secret manually.
  - Enrolment succeeds, recovery codes are printed, and the second login with a fresh code from the app succeeds.
  - Store one recovery code. Afterwards, the admin account requires 2FA at every login.
  - On later `smoke:api` runs, the script prompts for a code at login.

### 7. Redis outage behaviour

- [x] With the API running: `docker compose stop valkey`.
- [x] `/health/ready` still returns **200**, with `"redis":"fail"`.
- [x] `npm run smoke:api -- --rate-limit` (wait 1 minute after the previous run) still passes. The 429 proves limits survive the outage via per-instance counters.
- [x] The API log shows `rate limiting is using per-instance counters (redis unavailable)` and `redis error (…)` warnings **at most once per minute each**, not once per request or per reconnect attempt.
- [x] `docker compose start valkey`. Within ~30 s, `/health/ready` shows `"redis":"ok"` again **without restarting the API**.

### 8. Dev email flow (no SMTP configured)

- [x] Register through the API:
      `curl.exe -s -X POST http://127.0.0.1:3000/v1/auth/register -H "content-type: application/json" --data-binary "@register.json"`,
      where `register.json` contains `{"email":"dev@example.com","password":"a long dev passphrase","displayName":"Dev"}`.
      Response: `{"status":"verification_pending"}` with HTTP 202.
- [x] The API log contains a `DEV EMAIL (not sent)` entry with a link of the form `…/verify-email#token=…`.
- [x] POST that token to `/v1/auth/verify-email` (`{"token":"<token>"}`); then logging in as dev@example.com works.
- [x] Repeating the registration returns the **identical** 202 response, and the log shows a "Sign-up attempt" email instead (no account enumeration).

### 9. Production guard rails

- [x] Temporarily set `APP_ENV=production` in `.env` and run `npm run api:start`. It must **refuse to start**, listing at least:
      `PUBLIC_BASE_URL` (https), `NETWORK_MODE` (mainnet), `SMTP_HOST` (required), and the placeholder/secret checks that apply.
      No secret values may appear in the output. Restore `APP_ENV=development`.

### 10. Log and database hygiene

- [x] Search the API log output (copy the terminal output to a file if needed) for your admin password, `ap_session=`, and `apk_test_` followed by a long secret. **None** may appear.
- [x] In psql (`docker compose exec postgres psql -U actualpay -d actualpay_dev`):
  - `SELECT left(password_hash, 10) FROM users;` → every row starts with `$argon2id$`
  - `SELECT token_hash FROM sessions LIMIT 3;` → 64-char hex, never the cookie value
  - `SELECT left(secret_ciphertext, 3) FROM totp_credentials;` → `v1.` (encrypted)
  - `DELETE FROM api_keys;` → fails with `append-only`
  - `SELECT action, count(*) FROM audit_log GROUP BY action ORDER BY 1;` shows login, organization and API key events from the smoke runs

### Phase 2 known limitations (do not "fix" without asking)

- Expired sessions, tokens and idempotency rows are not purged yet (Phase 6 job system).
- No platform-admin API or dashboard yet (Phase 9); `is_platform_admin` is stored but unused.
- No breached-password check and no passkeys yet.

---

## Phase 3: Watch-only chain adapters

Read `docs/chains.md` first. Phase 3 adds `packages/chains`, two CLIs
(`chain:probe`, `chain:watch`) and new configuration. No database changes.
Nothing in this phase can sign or send transactions.

**Use testnets and local dev chains only. Never put mainnet credentials or
funds anywhere in this phase.**

### 1. Update configuration

- [x] Add the new keys from `.env.example` to `.env`: `BITCOIN_WALLET_NAME`,
      `BITCOIN_CONFIRMATIONS`, `LITECOIN_WALLET_NAME`, `LITECOIN_CONFIRMATIONS`,
      `LITECOIN_WALLET_MODE`, `ETHEREUM_CHAIN_ID`, `XRPL_DEPOSIT_ACCOUNT`, and
      the commented `EVM_TEST_RPC_URL` / `UTXO_REGTEST_*` lines.
- [x] `npm ci` (new dependencies: `@scure/bip32`, `@scure/base`,
      `@noble/hashes`, `@noble/curves`, `xrpl`; dev: `@scure/bip39`).
- [x] `npm run verify` passes. Without the optional chain test variables you
      will see **85 unit tests passed** and the 13 chain integration tests
      **skipped**. That is expected until steps 2–3.

### 2. EVM integration tests with Anvil (local, no internet funds)

- [x] Install Foundry (https://getfoundry.sh; on Windows use WSL, or download
      the Windows `anvil.exe` from the Foundry GitHub releases).
- [x] Start Anvil: `anvil --port 8545 --chain-id 31337`.
- [x] Set `EVM_TEST_RPC_URL=http://127.0.0.1:8545` in `.env`.
- [x] `npm run test:integration -- tests/integration/chain-evm.test.ts`:
      **7 passed**. Run it **twice without restarting Anvil**. The second run
      must also pass, which proves the tests tolerate an existing chain state.

### 3. UTXO integration tests with a regtest node

Do this with **Bitcoin Core v30 or newer** (descriptor mode). It could not be
tested in the build environment, so this is the first real check of Bitcoin
Core v30 compatibility. Optionally repeat with Litecoin Core 0.21.4 (legacy
mode), which CI already covers.

- [ ] Download Bitcoin Core from https://bitcoincore.org (verify the release
      signatures/hashes as described there; **not v30.0 or v30.1**, which were
      withdrawn for a wallet-migration bug. Use v30.2 or later).
- [x] Start a regtest node in a scratch data directory:
      `bitcoind -regtest -datadir=<scratch dir> -rpcuser=u -rpcpassword=p -rpcport=18443 -fallbackfee=0.0001`
      (create the directory first; on Windows use `bitcoind.exe`).
- [x] In `.env`: `UTXO_REGTEST_URL=http://u:p@127.0.0.1:18443` and `UTXO_REGTEST_CHAIN=bitcoin`.
- [x] `npm run test:integration -- tests/integration/chain-utxo.test.ts`: **6 passed**.
      Run it twice against the same node; both runs pass.
  - If `createwallet` or `importdescriptors` fails, record the exact error
    under Findings. Do **not** switch Bitcoin to legacy mode: v30 has no
    legacy wallets.
- [x] Full suite: `npm run verify` now shows **83 integration tests passed** (none skipped).

### 4. Probe the configured backends

- [ ] With `ENABLED_ASSETS=xrp` (default dev config): `npm run chain:probe`
      prints `OK xrpl tip=… final=…` plus live reserve values, and exits 0.
- [x] Negative checks (restore afterwards):
  - Set `ETHEREUM_CHAIN_ID=1`, enable `eth` and point `ETHEREUM_RPC_URL` at
    Anvil. The probe must print `FAIL … RPC endpoint is chain 31337, expected 1`.
  - Use a wrong RPC password for a node. The probe must print `rejected the
credentials (HTTP 401)` **without** printing the password.

### 5. Live testnet checks

These verify the TRON and XRPL adapters against real networks for the first
time (they were built against documented response shapes). Use testnet faucets
only. For each check, record in Findings: the transaction hash, what
`chain:watch` printed, and whether the amount matches **exactly**.

**XRPL testnet**

- [x] Create a funded testnet account with the official XRPL testnet faucet
      (xrpl.org → "XRP Faucets"). Note its classic address and secret. The
      secret stays in your own wallet tool, **never** in ActualPay config.
- [x] Set `XRPL_DEPOSIT_ACCOUNT=<that address>`, then run `npm run chain:probe`.
      It reports `RequireDest: NOT SET`.
- [x] Note the current validated ledger (`tip=` from the probe). From a
      _second_ faucet account, send two payments to the deposit account: one
      with `DestinationTag: 42` and one without a tag.
- [x] `npm run chain:watch -- --chain xrpl --from <ledger noted above>` shows
      both payments as `FINAL`, with exact drop amounts, `tag=42` on the first
      and no tag on the second.
- [x] Set the `asfRequireDest` flag on the deposit account (an `AccountSet`
      transaction with your wallet tool). The probe now reports `RequireDest: set`,
      and an untagged payment is rejected by the network (`tecDST_TAG_NEEDED`).

**TRON Nile testnet**

- [x] In `.env`: `ENABLED_ASSETS=trx`, `NETWORK_MODE=testnet`,
      `TRON_API_URL=https://nile.trongrid.io`. A key is optional on Nile.
- [ ] Get Nile TRX from the Nile faucet for a TronLink testnet wallet. Send
      some TRX to a second address you control.
- [x] `npm run chain:watch -- --chain tron --address <receiving address> --since-minutes 30`
      lists the transfer as `FINAL` with the exact amount in **sun**
      (1 TRX = 1,000,000 sun). It may take ~1 minute to appear, because only
      solidified data is used.
- [ ] Optional, USDT-style TRC-20: Nile has no official USDT. If you deploy or
      obtain a Nile TRC-20 test token, set `ENABLED_ASSETS=trx,usdt-trc20` and
      `USDT_TRC20_CONTRACT=<its address>`, send a transfer, and confirm
      `chain:watch` shows it with a ref ending in `:<event index>`.
- [x] If any field name differs from what the adapter expects (the scan
      errors with `malformed …`), record the raw API response under Findings.
      Do **not** loosen the parsing; it is deliberately strict.

**Ethereum Sepolia**

- [x] In `.env`: `ENABLED_ASSETS=eth`, `ETHEREUM_RPC_URL=<a Sepolia RPC URL>`,
      and remove `ETHEREUM_CHAIN_ID` (the default for testnet is Sepolia, 11155111).
- [x] `npm run chain:probe` shows ethereum with `final` roughly 64–96 blocks behind `tip`.
- [ ] Send Sepolia ETH (from a faucet-funded wallet) to an address you control.
      Then `npm run chain:watch -- --chain ethereum --address <it> --from <block before the tx>`
      shows it `PENDING` at first and `FINAL` after ~15 minutes when re-run.

**Bitcoin testnet4 or signet** (optional, needs a synced node)

- [ ] If you run a synced testnet4/signet Bitcoin Core v30+ node: export an
      account tpub (`m/84'/1'/0'`) from a test wallet, then run
      `npm run chain:watch -- --chain bitcoin --xpub <tpub> --index 0 --from <recent block hash>`.
      It creates the watch-only wallet, prints address #0, and after you pay
      that address the payment appears (re-run to see confirmations grow).

### 6. Safety checks

- [x] `npm run chain:watch -- --chain bitcoin --xpub <an xprv/tprv>` is
      refused with `extended PRIVATE key`. (Use a throwaway key generated for this test.)
- [x] Against the regtest node, `getwalletinfo` on the ActualPay wallet shows
      `"private_keys_enabled": false`.
- [x] Search all CLI output from this phase for RPC passwords and API keys: none appear.

### Phase 3 known limitations (do not "fix" without asking)

- ETH/TRX sent by smart contracts (internal transfers) is not detected; Phase 6
  reconciliation will flag it.
- Nothing yet refuses to credit while a node is unsynced, and deposit
  addresses are not stored. Both arrive in Phases 4–6.
- TRON and XRPL adapters were developed against documented response shapes;
  step 5 is their first live validation.

---

## Phase 4: Wallets and deposit addresses

Read `docs/wallets.md` first. Phase 4 adds migration `0005_wallets`, the
`packages/wallets` package and the `/wallets` endpoints. Watch-only: nothing in
this phase can spend. Testnets only.

### 1. Update and verify

- [ ] `npm ci`, then `npm run db:migrate` prints `applied: 0005_wallets`.
- [ ] `npm run verify` passes with **91 unit tests** and **99 integration tests**
      (`tests/integration/wallets.test.ts` is 14 of them; none skipped when the
      chain test nodes are running).
- [ ] The derivation vectors pass: `tests/unit/wallets-derivation.test.ts`
      (BIP84 mainnet addresses and the well-known Ethereum address for the
      standard test mnemonic).

### 2. Manual database guarantees

Run against the dev database; each must **fail**:

- [ ] `UPDATE wallets SET chain = 'tron';` → `immutable`
- [ ] `UPDATE wallets SET next_index = 0;` (on a wallet that issued addresses) → `backwards`
- [ ] `DELETE FROM wallets;` → `append-only`
- [ ] `UPDATE deposit_addresses SET address = 'x';` (needs at least one issued address; with an empty table it reports `UPDATE 0`) → `append-only`
- [ ] `TRUNCATE deposit_addresses;` → `append-only`

### 3. Real wallet software (the check the tests cannot do)

- [ ] In a wallet you control (a **testnet** profile; never real funds), export
      the account public key for Ethereum (`m/44'/60'/0'`) and for Bitcoin
      testnet (`m/84'/1'/0'`).
- [ ] Sign in as an owner with 2FA enabled. Register each key with
      `POST /v1/organizations/:orgId/wallets`. The API response's first address
      must equal the first address your wallet software shows for that account.
      If it does not, record the wallet, path and both addresses under Findings
      and do not "fix" the derivation.
- [ ] A wrong address at `…/confirm` returns 400 and the audit log shows
      `wallet.confirmation_failed`; the right one returns 200.
- [ ] Without 2FA the same call returns `MFA_REQUIRED`.
- [ ] Registering the same key again (even as a `vpub`/`tpub`) returns 409.

### Phase 4 known limitations (do not "fix" without asking)

- One XRPL account serves one organization (destination tags are per wallet).
- No public "new address" endpoint; addresses are issued by invoices (Phase 5).
- Change addresses (`/1/*`) are unused until Phase 8.
- Watchers for archived wallets arrive with Phase 6.

---

## Phase 5: Invoices and payments

Read `docs/payments.md` first. Phase 5 adds migration `0006_invoices`, the
`packages/payments` package and the invoice, payment and payment-link
endpoints. Testnets only.

- [ ] `npm run db:migrate` prints `applied: 0006_invoices`.
- [ ] `npm run verify` passes with **108 unit tests** and **127 integration tests**
      (none skipped when the chain test nodes run).
- [ ] With the API running and a confirmed testnet ETH wallet (Phase 4 manual
      steps): create an invoice with an API key, open `hostedUrl`'s public data
      at `GET /v1/public/invoices/:publicId` and check the address and the
      `paymentUri` open correctly in your wallet app with the amount filled in.
- [ ] Create a payment link, call its public `POST …/invoices` more than
      `maxOpenInvoices` times: the extra calls return 429.
- [ ] Confirm the public views never show `externalId` or `metadata`.
- [ ] Manual DB guarantees (each must fail): `UPDATE invoices SET amount_due = 1;`
      (immutable), `DELETE FROM payments;`, `DELETE FROM domain_events;`
      (append-only), `UPDATE payments SET status = 'pending' WHERE status = 'confirmed';`
      (cannot go from).

### Phase 5 known limitations (do not "fix" without asking)

- No fiat pricing: amounts are in the crypto asset.
- A reversal the books cannot absorb throws; operator booking comes in Phase 6.
- Chain watchers (Phase 6) are what feed payments in; until then payments
  only arrive through the `recordObservation` function.

---

## Phase 6: Chain watching and the worker

Read `docs/watcher.md` first. Phase 6 adds migration `0007_watcher`, the
`packages/watcher` package and the `apps/worker` process. Testnets only.

- [ ] `npm run db:migrate` prints `applied: 0007_watcher`.
- [ ] `npm run verify` passes with **108 unit tests** and **147 integration tests**
      (none skipped when Anvil and regtest bitcoind are running; the two
      `watcher-*.test.ts` files are the real-chain end-to-end runs).
- [ ] Add `WORKER_SCAN_INTERVAL_SECONDS` to `.env` (default 15).
- [ ] Without the worker running, creating an invoice fails with
      `UPSTREAM_UNAVAILABLE`. Start it (`npm run worker:dev`) and it succeeds.
- [ ] `npm run worker:status` prints a cursor per watched chain, leases, and
      (ideally) no open issues.
- [ ] **Real testnet payment, end to end.** With XRPL or Sepolia ETH (Phase 3
      faucet steps), register and confirm a wallet, create an invoice for a
      small amount, pay it from a wallet app, and watch the invoice go
      `open → processing → paid` with the exact amount. Record the transaction
      hash under Findings.
- [ ] Stop the worker, pay an invoice, wait, start the worker again: the payment
      is still found (the cursor catches up).
- [ ] Run two workers at once (two terminals): `worker:status` shows each lease
      held by one worker; payments are still credited exactly once.
- [ ] Stop your Bitcoin/Ethereum node while the worker runs: the worker logs the
      failure, `chain_cursors.last_error` is set, nothing is reversed, and it
      recovers on its own when the node returns. After 15 minutes of no scans a
      `watcher_stale` issue opens.
- [ ] Manual DB guarantees (each must fail): `DELETE FROM chain_cursors;`
      (append-only), `UPDATE wallets SET watched_through = 0;` on a wallet with
      a non-zero value (cannot shrink).

### Phase 6 known limitations (do not "fix" without asking)

- ETH/TRX sent by smart contracts are not detected (see docs/watcher.md).
- Custody-vs-chain balance reconciliation waits for Phase 8.
- Issues are rows, not alerts; wiring to monitoring is an operator step.

---

## Phase 7: Webhooks

Read `docs/webhooks.md` first. Phase 7 adds migration `0008_webhooks`, the
`packages/webhooks` package and the `/webhooks` endpoints; the worker now also
delivers. Testnets only.

- [ ] `npm run db:migrate` prints `applied: 0008_webhooks`.
- [ ] `npm run verify` passes with **179 unit tests** and **168 integration tests**
      (none skipped when Anvil and regtest bitcoind are running).
- [ ] Add `WEBHOOK_ALLOW_HTTP=true` and `WEBHOOK_ALLOW_PRIVATE_NETWORKS=true` to a
      **development** `.env` only, and start a local receiver (for example
      `npx http-echo-server` or any small script on `http://127.0.0.1:9000`).
- [ ] Register it: `POST /v1/organizations/:orgId/webhooks` with
      `{"url":"http://127.0.0.1:9000/hook"}`. Keep the `secret` it returns.
- [ ] `POST …/webhooks/:id/test` while the worker runs: the receiver gets a
      `webhook.test` request within one worker interval, and your own code (use
      the sample in `docs/webhooks.md`) verifies the signature.
- [ ] Create and pay a testnet invoice (Phase 6 steps): the receiver gets
      `invoice.created`, `payment.detected`, `invoice.processing`,
      `payment.confirmed` and `invoice.paid`.
- [ ] Stop the receiver, trigger an event, start it again: it is retried
      (`GET …/webhooks/:id/deliveries` shows the attempts).
- [ ] Set both webhook flags to `true` with `APP_ENV=production` and confirm the
      configuration refuses to start. Remove them afterwards.
- [ ] Try to register `https://169.254.169.254/x`, `https://10.0.0.1/x` and
      `https://localhost/x` against a production-like config: each is refused.
- [ ] Rotate the secret and confirm the next request carries two `v1=` values.

### Phase 7 known limitations (do not "fix" without asking)

- No email when an endpoint is auto-disabled (Phase 10).
- Old deliveries are not purged automatically.

---

## Phase 8: Signer and withdrawals

Read `docs/withdrawals.md` first. Phase 8 adds migration `0009_withdrawals`, the
`packages/withdrawals` and `packages/signer` packages, `apps/signer`, and the
withdrawal and `/v1/admin` endpoints. **Test networks and local chains only.**
It is optional: the default `CUSTODY_MODE=merchant` has no withdrawals at all.

- [ ] `npm run db:migrate` prints `applied: 0009_withdrawals`.
- [ ] `npm run verify` passes with **224 unit tests** and **226 integration tests** (Anvil and regtest bitcoind running, nothing skipped).
- [ ] With `CUSTODY_MODE=platform`, run `npm run signer:init` on a scratch machine,
      confirm the 24 words are shown once and the keystore file is not readable
      with a wrong passphrase.
- [ ] Register the printed hot addresses as an MFA platform administrator and fund
      them on **testnet** only; withdraw a small amount of each asset end to end.
- [ ] Confirm the requester cannot approve their own withdrawal, a user without
      MFA cannot approve, and `pause` stops signing immediately.
- [ ] Edit an approved withdrawal's amount directly in the database: the signer
      must refuse it (seal).
- [ ] Confirm `needs_review` withdrawals never release their hold on their own.

### Phase 8 known limitations (do not "fix" without asking)

- XRP and TRON withdrawals are unsupported.
- Software keystore (no HSM); the seal does not defend against a full API-host compromise.
- No on-chain vs ledger reconciliation of the hot wallet yet.
- A dropped signed EVM transaction (nonce gap) needs manual handling.
- Operators must record gas funding via `/v1/admin/platform-funding`.

---

## Phase 9: Dashboards and hosted checkout

Read `docs/dashboard.md` first. Phase 9 adds `apps/web` (static files) and the
`/app` and `/pay` routes. No migration.

- [ ] `npm run verify` passes with **224 unit tests** and **233 integration tests**.
- [ ] Start `npm run api:start`, open `http://localhost:3000/app/`: register, verify
      (the email link or token is in the API log when SMTP is unset), sign in.
- [ ] Create an organization, add a testnet wallet, confirm the first address
      against your own wallet app, create an invoice, open its customer link in a
      private window and pay it on testnet.
- [ ] Browser dev tools → Network: no request leaves your own origin; Console shows
      no CSP violations on any page.
- [ ] Try `<script>alert(1)</script>` as an invoice description: it shows as text.
- [ ] As a second user with only the `viewer` role, buttons for create/approve are
      hidden and the API still refuses them.
- [ ] Optional: run `scripts/web-smoke.mjs` (see docs/dashboard.md).

### Phase 9 known limitations (do not "fix" without asking)

- No ledger/balance view, no payment-link creation form, no QR code, no i18n.
- The dashboard is English only and has not had an accessibility audit.

---

## Phase 10: Email notifications and alerts

Read `docs/notifications.md` first. Phase 10 adds migration `0010_notifications`,
the `packages/notifications` package, `/notifications` endpoints, a dashboard
page, and a notification step in the worker. Testnets only.

- [ ] `npm run db:migrate` prints `applied: 0010_notifications`.
- [ ] `npm run verify` passes with **224 unit tests** and **262 integration tests**.
- [ ] Set `SMTP_*` to a real test mailbox and `OPERATOR_ALERT_EMAIL` to yours;
      restart API and worker.
- [ ] Dashboard → Notifications: turn "Invoices paid" on, pay a testnet invoice:
      the mail arrives within one worker interval and contains no secrets.
- [ ] Request a withdrawal (platform mode): approvers get "needs approval".
- [ ] Add a forwarding address you control (needs MFA): it receives nothing until you
      click the confirmation link; after that it receives the chosen kinds.
- [ ] Open a critical issue (for example stop the signer mid-withdrawal until it
      needs review): exactly one alert arrives.
- [ ] Check SPF/DKIM/DMARC on the sending domain with a mail-tester service.

### Phase 10 known limitations (do not "fix" without asking)

- No digest or threshold options; no bounce handling; outbox rows are not purged.

---

## Phase 11: Documentation and OpenAPI

Read `docs/api.md`. Phase 11 adds `apps/api/src/openapi.ts`, `GET /v1/openapi.json`,
`npm run openapi:generate` and the committed `docs/openapi.json`. No migration.

- [ ] `npm run openapi:generate` leaves `git diff docs/openapi.json` empty.
- [ ] `npm run verify` passes with **224 unit tests** and **268 integration tests**.
- [ ] Open `docs/openapi.json` in Swagger UI (or Postman → Import) and call an
      invoice create against a running API with a test key.
- [ ] Follow `docs/api.md` as a stranger would; note anything that does not work.

### Phase 11 known limitations (do not "fix" without asking)

- Response examples are not generated; schemas are inlined (the file is large).
- No SDKs. Generate one from the OpenAPI document if you need it.

---

## Findings log

Record every failure, its root cause, and the fix (file and line), so the
next phase starts from known-good ground.

| Date       | Step                | Problem                                                                                                                                                                                               | Root cause                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Fix                                                                                                                                                                                                                                  |
| ---------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-08 | Env                 | No Docker daemon in the cloud sandbox                                                                                                                                                                 | Sandbox limitation                                                                                                                                                                                                                                                                                                                                                                                                                                            | Ran native PostgreSQL 16 and redis-server 7.0 with the same credentials as docker-compose.yml. Valkey was not used.                                                                                                                  |
| 2026-10-08 | Phase 1-3           | Not verifiable in the sandbox: Docker steps, interactive `admin:create` prompt (no TTY), real authenticator MFA, Anvil, regtest Bitcoin Core, XRPL/TRON/Sepolia/testnet4 live checks, `getwalletinfo` | No network access to testnets, Foundry or bitcoincore.org; no TTY                                                                                                                                                                                                                                                                                                                                                                                             | Left unticked. Run locally.                                                                                                                                                                                                          |
| 2026-10-08 | Phase 3 §2          | none                                                                                                                                                                                                  | Anvil 1.5.1 (downloaded from the Foundry GitHub release) ran `chain-evm.test.ts` twice: 7 passed each.                                                                                                                                                                                                                                                                                                                                                        | None needed.                                                                                                                                                                                                                         |
| 2026-10-08 | Phase 3 §3          | none                                                                                                                                                                                                  | Bitcoin Core **v30.3** regtest (descriptor wallets): `chain-utxo.test.ts` ran twice, 6 passed each. Full `npm run verify` is green with 85 unit and 83 integration tests and none skipped. Watch wallets report `private_keys_enabled: false`. SHA256 matched `SHA256SUMS`, but the GPG signature was **not** verified (builder keys could not be fetched), so please verify it yourself.                                                                     | None needed.                                                                                                                                                                                                                         |
| 2026-10-08 | Phase 3 §4-5        | The sandbox proxy blocks WebSocket upgrades, and the XRPL client only speaks WebSocket.                                                                                                               | Environment limitation, not an adapter bug.                                                                                                                                                                                                                                                                                                                                                                                                                   | Ran a throwaway local ws-to-HTTPS JSON-RPC bridge to `testnet.xrpl-labs.com`; it is not in the repo. Everything else XRPL was real testnet. Please re-run natively once.                                                             |
| 2026-10-08 | Phase 3 §5 XRPL     | none                                                                                                                                                                                                  | Two throwaway funded accounts. Payments to the deposit account: 12345678 drops with tag 42 (tx 5F8B603872B2D00E011541D32B7E882D78A6093E4A1729FA69B32E81E725E9BE) and 2000001 drops untagged (tx AABAC6130767ECCE516229A411ADAC8A352C57D97449B380A869860CDE2BC846). `chain:watch` showed both FINAL with exact amounts and the correct tags. After `asfRequireDest`, the probe reports `RequireDest: set` and an untagged payment returns `tecDST_TAG_NEEDED`. | None needed.                                                                                                                                                                                                                         |
| 2026-10-08 | Phase 3 §5 TRON     | Could not get Nile TRX (faucet needs social login).                                                                                                                                                   | Verified instead against existing real Nile transfers: tx 05d9ab58... (315 sun) and 3985f9da... (630 sun) appear as FINAL with the exact amounts. The TRX send/receive step and the optional TRC-20 step were not done.                                                                                                                                                                                                                                       | None needed. Parsing was not loosened.                                                                                                                                                                                               |
| 2026-10-08 | Phase 3 §5 Sepolia  | Could not get Sepolia ETH (faucets need captcha).                                                                                                                                                     | Probe shows final 69 behind tip. Real recent Sepolia transfers show PENDING (11-12 confirmations) and FINAL (213+). `chain:watch` re-reports non-final transfers each scan with a stable `ref`, as designed.                                                                                                                                                                                                                                                  | None needed.                                                                                                                                                                                                                         |
| 2026-10-08 | Env note            | The adapters' Node `fetch` calls bypass the sandbox proxy and fail with 403.                                                                                                                          | Node ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1`.                                                                                                                                                                                                                                                                                                                                                                                                     | Set that variable for the sandbox only. No code change.                                                                                                                                                                              |
| 2026-10-08 | Phase 2 §3          | Expected counts in the Phase 2 checklist (63 unit, 70 integration) are stale.                                                                                                                         | Phase 3 added tests.                                                                                                                                                                                                                                                                                                                                                                                                                                          | Current counts are 85 unit and 83 integration. Line left unticked.                                                                                                                                                                   |
| 2026-10-09 | Phase 3 §3 optional | none                                                                                                                                                                                                  | Litecoin Core 0.21.4 regtest (legacy mode; archive SHA256 matches the CI pin): `chain-utxo.test.ts` ran twice, 6 passed each.                                                                                                                                                                                                                                                                                                                                 | None needed.                                                                                                                                                                                                                         |
| 2026-10-26 | Phase 6/7 regtest   | `chain-utxo.test.ts` failed intermittently with an empty first scan, then with "Insufficient funds"                                                                                                   | (1) Bitcoin Core tells wallets about mempool transactions asynchronously, so a scan issued milliseconds after `sendtoaddress` can miss it (harmless in production: the next scan sees it). (2) Regtest block rewards halve every 150 blocks, so a node that has mined for a long time cannot fund the tests.                                                                                                                                                  | Tests now poll (`eventually`) for first visibility, mine 110 blocks, use smaller amounts, and fail with a clear message when the miner is out of funds. Use a fresh regtest datadir if you ever see that message. No product change. |
| 2026-10-26 | Phase 11 verify     | `api-orgs.test.ts` "shows the secret once" failed intermittently; the regtest miner ran dry again                                                                                                     | Same `split('_')[3]` fragment pitfall as the unit test; each full verify mines ~550 regtest blocks and rewards halve every 150                                                                                                                                                                                                                                                                                                                                | Compare whole secret. For regtest: `bitcoin-cli stop`, delete `<datadir>/regtest`, start again whenever the "too little" message appears (documented).                                                                               |
| 2026-10-08 | Phase 3 §6          | `chain:watch` queries node status before parsing `--xpub`, so an xprv is refused only once a node is reachable.                                                                                       | CLI ordering in `apps/api/src/cli/chain-watch.ts`.                                                                                                                                                                                                                                                                                                                                                                                                            | Not changed. Against the regtest node the xprv was refused with `extended PRIVATE key` and the key was not echoed.                                                                                                                   |

## Open questions

Items needing a human decision. Do not resolve these unilaterally.

- Should two organizations be able to share one XRPL receiving account? Today the answer is no (one account per organization); sharing needs deployment-wide destination tags. See `docs/wallets.md`.
