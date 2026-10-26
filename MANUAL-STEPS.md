# Everything you need to do manually

All 13 roadmap phases are implemented and pushed to `main` (and the branch
`claude/wonderful-fermi-l4tvm6`). Automated checks pass: `npm run verify` runs
234 unit and 293 integration tests, none skipped, against real PostgreSQL, Anvil
(Ethereum) and Bitcoin Core regtest. This file lists what automation could not
do. Work top to bottom; the first sections matter most.

**Rules that stay true:** testnets and local chains only until the independent
review in section 1 is done. Never put real funds into this. The default
`CUSTODY_MODE=merchant` (no keys held, no withdrawals) is the only mode I would
consider for a first real deployment.

---

## 1. Before any real money (blocking)

- [ ] **Independent security review / penetration test** of the API, the signer
      and the keystore. Everything in `docs/threat-model.md` is the authors' own
      review, not an audit.
- [ ] Decide **custody mode** deliberately. `platform` mode makes you a custodian
      (legal/regulatory duties in many places; get advice). Read the "Residual"
      notes in `docs/threat-model.md` first.
- [ ] Read `docs/threat-model.md` → "Before real funds" and tick each item or write
      down why not.
- [ ] No fiat pricing exists: invoices are in crypto units. Decide how you will price.

## 2. GitHub repository settings (only you can do these)

- [ ] Set `main` as the **default branch**.
- [ ] Enable **private vulnerability reporting**, then replace the placeholder in
      `SECURITY.md` with that channel.
- [ ] Check the latest **CI run on `main`** is green (the last push, `e71d070`,
      included the new `image` job that builds the Docker image: it is the first
      time that Dockerfile is ever built). If the `image` job fails, paste me the log.
- [ ] Dependabot PRs: the **dev-tooling major bump** (typescript 7, vitest 5, eslint 10,
      @types/node 26) fails CI and needs a deliberate migration; close it or
      migrate. The zod 4 upgrade is already done by hand, so the zod Dependabot PR
      is obsolete. Patch/minor PRs can be merged after CI passes.
- [ ] Optionally open a PR from the feature branch (I never open PRs unless asked).

## 3. Things I could not run here (run once, locally)

| What                                                                     | How                                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Docker build and compose** (never run: no Docker daemon in my sandbox) | Follow `docs/deployment.md` §3-5 on a **staging** machine with `APP_ENV=staging`/testnet values. `TASKS.md` Phase 13 has the checklist.                                                                 |
| Caddy certificate issuance, Postgres role init script                    | Same staging run.                                                                                                                                                                                       |
| Interactive `npm run admin:create` password prompt                       | Run it in a real terminal.                                                                                                                                                                              |
| Real authenticator-app MFA                                               | Enrol with a phone app; the tests use a TOTP library.                                                                                                                                                   |
| TRON and Sepolia live sends                                              | Faucets need a browser/captcha; verified only with real existing transfers.                                                                                                                             |
| First-address confirmation in a **real wallet app**                      | `TASKS.md` Phase 4 §3: derive in Sparrow/MetaMask/etc. and confirm the first address matches.                                                                                                           |
| Bitcoin Core **GPG signature**                                           | I verified the SHA256 only; verify the release signature yourself.                                                                                                                                      |
| XRPL live checks natively                                                | I used a local WebSocket bridge because my sandbox proxy blocks WebSockets. Re-run once.                                                                                                                |
| Browser smoke test                                                       | `scripts/web-smoke.mjs` (needs Playwright; wipes the test DB). It passed for me. Also open `/app/` by hand once and look at it: **I never saw the UI visually**, only drove it with a headless browser. |
| Phase checklists                                                         | `TASKS.md` has an unticked checklist per phase (1-13). They are your acceptance tests.                                                                                                                  |

## 4. Infrastructure you must provide

- [ ] **Your own chain nodes** (Bitcoin Core, Litecoin Core, an Ethereum
      execution + consensus pair, TRON, XRPL). Do not rely on public RPC for money.
      Guidance in `docs/deployment.md` §2.
- [ ] **SMTP** account, plus **SPF, DKIM, DMARC** on the sending domain. Set
      `OPERATOR_ALERT_EMAIL` to a mailbox that wakes someone up.
- [ ] **Domain, DNS and TLS** (the provided Caddy file handles certificates).
- [ ] **PostgreSQL backups** off the host, with point-in-time recovery, and a
      **restore drill** (`deploy/backup.sh` is a starting point). Do this _before_
      accepting payments.
- [ ] **Monitoring and alerting** for everything in the table in `docs/deployment.md`
      §8. The app emails on critical issues but is not a pager: add an external
      uptime check, worker-heartbeat check, node sync and disk alerts.
- [ ] Run **two workers** and two API replicas for availability; PostgreSQL in the
      stack file is a single instance (use a managed/HA database for production).
- [ ] Host hardening checklist, `docs/deployment.md` §10.
- [ ] Pin the Dockerfile base image **by digest**; consider image signing and an SBOM.
- [ ] Generate every secret fresh (`docs/deployment.md` §4) and store a copy in a
      vault. **Losing `encryption_key` loses TOTP seeds and webhook secrets**; there is
      no online rotation.

## 5. Operating the payment side

- [ ] `reversal_blocked` and other **critical issues mean real money is in question**:
      investigate, never edit balances in SQL (history is append-only; corrections are
      new journals).
- [ ] Webhook receivers: follow `docs/webhooks.md` (verify the signature on the raw
      body, de-duplicate by event id). Decide your egress policy for the worker (it
      calls customer URLs; SSRF guards are on, **never** set `WEBHOOK_ALLOW_HTTP` or
      `WEBHOOK_ALLOW_PRIVATE_NETWORKS` in production, the config refuses it).
- [ ] Decide retention: webhook deliveries, `email_outbox` and expired sessions/tokens are
      **not purged automatically**. Add a scheduled cleanup.
- [ ] One XRPL receiving account per organization (open question in `TASKS.md`: do you
      want a shared account with deployment-wide destination tags?).
- [ ] The dashboard is English-only, has no ledger/balance view, no payment-link
      creation form and no QR code (see `docs/dashboard.md`). Build what you need.

## 6. Only if you run platform custody mode (you hold funds)

- [ ] Signer on its **own hardened host** (`deploy/signer/`), no inbound ports.
- [ ] `signer init` prints a **24-word phrase once**: write it on paper, store it
      offline in two places. The passphrase file is separate. The keystore and the words
      are **not** in database backups.
- [ ] Register the hot-wallet addresses as an MFA platform administrator; start with a
      **small balance** and a mainnet dust test.
- [ ] Record gas you add to hot wallets via `POST /v1/admin/platform-funding`, or fee
      settlement blocks with a critical issue.
- [ ] Hot wallet **balance vs ledger is not reconciled automatically**: check it yourself,
      regularly.
- [ ] Known weak points (accepted, documented): the seal key lives with the API host, so a
      full API-host compromise plus that key can authorise withdrawals up to the hot-wallet
      balance; software keystore (no HSM); no nonce-gap recovery if a signed EVM transaction
      is dropped (manual); XRP and TRON withdrawals are not supported; BTC/LTC change is not
      re-spent until confirmed. Keep the hot wallet small and consider an HSM before volume.
- [ ] Set cool-down and policy delay to 24 h or more (production config enforces at least 1 h).
- [ ] Practise the pause switch and the incident runbook (`docs/deployment.md` §9).

## 7. Known limitations (decisions I did not make for you)

- Not independently audited; pre-release; API is `v1` but unstable until you say otherwise.
- No WebAuthn/passkeys (TOTP only); no per-tenant quotas; no SMS/push/digest notifications.
- No fiat prices, no refunds flow, no sweeping/forwarding of customer funds (merchant mode
  pays merchants directly). "Optional forwarding" was implemented as **notification
  forwarding** to outside email addresses; tell me if you meant something else.
- Dev-only dependency advisories remain in `vitest`'s toolchain (not shipped); production
  dependencies audit clean (`npm audit --omit=dev`).
- Regtest tests share one miner wallet now; if a long-running local node ever says "too
  little to fund these tests", delete its `regtest` directory and restart it.

## 8. Where things are

| Topic                                        | File                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| Design and roadmap                           | `docs/architecture.md`                                                     |
| Money and ledger                             | `docs/ledger.md`                                                           |
| Accounts and access                          | `docs/security-model.md`                                                   |
| Threat model                                 | `docs/threat-model.md`                                                     |
| Chains, wallets, payments, watcher           | `docs/chains.md`, `docs/wallets.md`, `docs/payments.md`, `docs/watcher.md` |
| Webhooks, notifications                      | `docs/webhooks.md`, `docs/notifications.md`                                |
| Withdrawals and signer                       | `docs/withdrawals.md`                                                      |
| Dashboard                                    | `docs/dashboard.md`                                                        |
| API (OpenAPI is generated)                   | `docs/api.md`, `docs/openapi.json`, `GET /v1/openapi.json`                 |
| Deploying and operating                      | `docs/deployment.md`, `deploy/`, `Dockerfile`                              |
| Per-phase acceptance checklists and findings | `TASKS.md`                                                                 |
| Local setup without Docker                   | `docs/local-setup-no-docker.md`                                            |
