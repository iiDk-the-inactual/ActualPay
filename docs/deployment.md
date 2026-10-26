# Deployment

Phase 13. How to run ActualPay for real: image, stack, secrets, upgrades,
backups, monitoring and incident response.

> **Honest status.** The container files here were written and statically
> checked (tests parse them and validate the configuration they produce), and
> the production bundle was run with production dependencies only. They have
> **not** been built or started under Docker in the authoring environment (no
> Docker daemon was available). Rehearse the whole thing on a staging machine
> first, on testnets, before it goes near real money. And read
> `docs/threat-model.md` → "Before real funds": nothing here replaces an
> independent security review.

## 0. Decide before you deploy

| Question     | Guidance                                                                                                                                                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Custody mode | `merchant` (default): ActualPay holds no keys; merchants receive funds in their own wallets. `platform`: **you** hold customer funds in a hot wallet. That is a regulated activity in many places and the highest-risk configuration of this software. Start with `merchant`. |
| Network      | `APP_ENV=production` requires `NETWORK_MODE=mainnet`. For rehearsal use a separate stack with `APP_ENV=staging` and `NETWORK_MODE=testnet`. Never mix them in one database.                                                                                                   |
| Nodes        | Run your own (below). A public RPC provider can lie, lag or log your addresses.                                                                                                                                                                                               |

## 1. Topology

```
Internet ──▶ Caddy :443 ──▶ api ──┐
                                  ├──▶ PostgreSQL   (no route to the internet)
                           worker ┤──▶ Valkey       (no route to the internet)
                                  └──▶ your chain nodes, SMTP, webhook receivers
signer (separate host, platform mode only) ──▶ PostgreSQL + your chain nodes only
```

- **api** — stateless; run 2 or more behind Caddy for availability.
- **worker** — scans chains, settles payments, sends webhooks and email. Several may run; leases make each task run in one place at a time. Run 2 so one can fail.
- **migrate** — one-shot job, runs before api/worker, as the schema **owner**.
- **signer** — exactly one, on its own hardened host, never exposed (see `docs/withdrawals.md`).
- Only Caddy publishes ports. PostgreSQL and Valkey are on an `internal` network.

Sizing for small deployments: 2 vCPU / 4 GB RAM for the stack above plus your nodes; nodes need their own disks and are the heavy part.

## 2. Chain nodes

| Chain                 | Node                                                                                           | Notes                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bitcoin               | Bitcoin Core (descriptor wallets), `-prune` is fine for watching                               | The worker creates a watch-only wallet; keep RPC bound to a private interface; use a long random RPC password. `-fallbackfee` not needed on mainnet. |
| Litecoin              | Litecoin Core (legacy wallet mode)                                                             | Same as Bitcoin.                                                                                                                                     |
| Ethereum / USDT-ERC20 | A full execution node **with** a consensus client (Geth/Nethermind/Erigon + Lighthouse/Prysm…) | The adapter uses finality tags; point `ETHEREUM_RPC_URL` at the execution RPC.                                                                       |
| TRON                  | Your own full node or a paid TronGrid key                                                      | `TRON_API_URL`, `TRON_API_KEY`.                                                                                                                      |
| XRP                   | rippled you operate, or a cluster you trust                                                    | `XRPL_WS_URL`; set `XRPL_DEPOSIT_ACCOUNT`.                                                                                                           |

Monitor each node's sync state; a stalled node shows as chain cursor lag in `GET /v1/admin/status`.

## 3. Build and publish the image

CI builds the image on every push (job `image`). To release:

```sh
docker build -t ghcr.io/your-org/actualpay:1.0.0 .
docker push ghcr.io/your-org/actualpay:1.0.0
```

Pin the base image by digest in the `Dockerfile` (`docker buildx imagetools inspect node:22-bookworm-slim`)
and deploy by **image digest**, not a moving tag. Consider signing images (cosign)
and generating an SBOM. The image: Node 22 on Debian slim, production
dependencies only (`npm ci --omit=dev --ignore-scripts`), plain bundled
JavaScript (no TypeScript loader), runs as the unprivileged `node` user.

One image, several commands: `node dist/api.mjs`, `dist/worker.mjs start`,
`dist/signer.mjs <init|addresses|start>`, `dist/db.mjs <migrate|grant|status>`,
`dist/admin-create.mjs`.

## 4. Secrets

Secrets are **files**, never environment values, never in the image or git
(`deploy/secrets/` and `deploy/.env` are git-ignored). The app reads
`<NAME>_FILE` for every setting. Create them with restrictive permissions:

```sh
mkdir -p deploy/secrets && cd deploy/secrets && umask 077
openssl rand -base64 33 > postgres_superuser_password
openssl rand -base64 33 > database_owner_password
openssl rand -base64 33 > database_app_password
openssl rand -base64 33 > redis_password
openssl rand -hex 32    > session_secret
openssl rand -base64 32 > encryption_key
openssl rand -base64 32 > withdrawal_seal_key      # platform mode only, else leave empty
printf 'postgres://actualpay_owner:%s@postgres:5432/actualpay' "$(cat database_owner_password)" > database_owner_url
printf 'postgres://actualpay_app:%s@postgres:5432/actualpay'   "$(cat database_app_password)"   > database_app_url
printf 'redis://:%s@valkey:6379' "$(cat redis_password)" > redis_url
: > smtp_username; : > smtp_password; : > bitcoin_rpc_password   # fill in what you use; unused ones stay EMPTY FILES
chmod 600 *
```

Rules: back these up in a password manager or vault (losing `encryption_key`
means losing TOTP seeds and webhook secrets; losing `session_secret` only
signs everyone out); never reuse the example values; rotate on any suspicion
(see §9). If the password may contain URL-reserved characters, percent-encode it
in the `*_url` files (base64 output can contain `/` and `+`: prefer `openssl rand -hex 32`).

## 5. First deploy

```sh
cp deploy/env.example deploy/.env && $EDITOR deploy/.env
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env logs migrate   # applied: 0001 … 0010
```

PostgreSQL's first start creates two roles: `actualpay_owner` (runs migrations
only) and `actualpay_app` (what api/worker/signer use: read/write rows, **cannot**
alter the schema, truncate, disable triggers or drop anything). The `migrate` job
applies grants after each run. This is tested (`tests/integration/db-roles.test.ts`).

Then:

1. Create the first administrator: `docker compose … run --rm -e ACTUALPAY_ADMIN_PASSWORD=… api node dist/admin-create.mjs --email you@example.com --name "You"` (prefer the interactive prompt: `run -it`). Enable MFA immediately in the dashboard.
2. Check `https://pay.example.com/app/`, `/v1/openapi.json`, and (from the host) `docker compose … exec api node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>r.text()).then(console.log)"`.
3. Set up backups (§7) **before** accepting payments.
4. Point monitoring at §8.

### Platform custody mode: the signer host

On a separate, minimal, patched machine (disk encryption, no inbound ports, SSH by key only):

1. Copy `deploy/signer/` and create its `secrets/` (database app URL, seal key **identical** to the API's, passphrase, RPC password).
2. `docker compose -f deploy/signer/docker-compose.signer.yml run --rm signer node dist/signer.mjs init` prints the 24-word phrase **once**. Write it on paper; store offline in two places.
3. Register the printed hot-wallet addresses as an MFA platform administrator (`POST /v1/admin/hot-wallets` or Admin page).
4. Start with a **small** hot-wallet balance and a mainnet dust test. Then `up -d`.
5. Allow the database port from the signer host only (firewall / `pg_hba.conf` with TLS: set `DATABASE_SSL=true` if the database is not on the same private network).

## 6. Upgrades

1. Read the release notes; take a backup (§7).
2. Pull the new image by digest, set `ACTUALPAY_IMAGE`, `docker compose … up -d`: `migrate` runs first, then api and worker restart. For zero downtime run two api replicas and restart one at a time.
3. Migrations are **forward only** (there is no "down"). If an upgrade goes wrong the rollback is: stop the stack, restore the backup, deploy the previous image.
4. Upgrade the signer last, on its own schedule, and only when no withdrawal is mid-flight.

## 7. Backups and restore

- `deploy/backup.sh` writes `pg_dump` output encrypted with `age` to a directory; ship it **off the host** (object storage with retention). Run it from cron at least daily; for money, also enable PostgreSQL WAL archiving / point-in-time recovery (pgBackRest, wal-g, or your cloud's managed backups).
- **Restore drill** every quarter on a scratch database (`age -d … | psql`), then `node dist/db.mjs status` and a read of `GET /v1/admin/status`. Record how long it took.
- After a restore: chains are re-scanned from their cursors; reconciliation will open issues for anything that disagrees. Do not resume withdrawals until the issues are understood.
- Back up secrets separately from the database (they must not travel together).
- Keystore and the 24 words are **not** in the database backup. See `docs/withdrawals.md`.

## 8. Monitoring and alerting

Alert on (page on **bold**):

| Signal                                             | How                                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Open critical issue**                            | `OPERATOR_ALERT_EMAIL` (one mail per issue) plus `GET /v1/admin/status` → `openIssues.critical > 0`                                      |
| **API down**                                       | external HTTP check on `https://…/app/`; container healthcheck on `/health/live`; `/health/ready` checks the database                    |
| **Chain cursor stale**                             | `chains[].scannedAt` older than 5 minutes, `synced: false`, or `lastError` set                                                           |
| **Worker not running**                             | `job_leases` rows with old `heartbeat`; `npm run worker:status` / `node dist/worker.mjs status`                                          |
| Withdrawals `needs_review`                         | email notice + dashboard                                                                                                                 |
| **Signer down** (platform mode)                    | approved withdrawals not turning `signed` for > 5 minutes                                                                                |
| Hot wallet balance low/high                        | on-chain balance of the hot addresses (platform mode); there is no automatic reconciliation yet, so check it against the ledger yourself |
| Email outbox backlog                               | `select count(*) from email_outbox where status='pending' and next_attempt_at < now() - interval '15 min'`                               |
| Webhook endpoints disabled                         | notice mail; `webhook_endpoints.status='disabled'`                                                                                       |
| Disk, memory, certificate expiry, backup freshness | your usual infrastructure monitoring                                                                                                     |

Logs are JSON on stdout (rotated by the compose logging options); ship them to
your log system. Secrets are redacted, but treat logs as sensitive (they contain
IP addresses, emails and request ids). Quote the `requestId` from an error
response to find the matching lines.

## 9. Incident runbook

**Always first: pause withdrawals** (`POST /v1/admin/withdrawals/pause`, or Admin → Pause). Investigate second.

| Situation                                     | Do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suspected API/host compromise                 | Pause withdrawals. Isolate the host. Rotate `session_secret` (signs everyone out) and the database passwords; **if platform mode, assume the seal key is known**: stop the signer, compare every `signed`/`broadcast` withdrawal against the audit log, then rotate the seal key and restart the signer. Rotating `encryption_key` is **not supported** online (webhook secrets and TOTP seeds are encrypted with it): plan a maintenance re-encryption or have users re-enroll MFA and recreate webhooks. |
| Suspected signer/keystore compromise          | Pause. Move remaining hot-wallet funds with the recovery phrase to a new wallet; `signer init` a new keystore; register the new addresses; retire the old hot wallet.                                                                                                                                                                                                                                                                                                                                      |
| `reversal_blocked` or reconciliation critical | Do not "fix" balances in SQL. Read the issue, compare with the chain explorer, decide with the people involved. Ledger history is append-only by design; corrections are new journals.                                                                                                                                                                                                                                                                                                                     |
| Chain node down or lying                      | Fix the node. Payments simply wait; invoices keep their addresses. Watch for reversal alerts after resync.                                                                                                                                                                                                                                                                                                                                                                                                 |
| Database lost                                 | Restore (§7), keep withdrawals paused, run the worker, review issues, then resume.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Mail provider down                            | Nothing is lost; the outbox retries for ~2 days. Critical alerts: use a second channel.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Lost signer passphrase                        | The keystore is unrecoverable without it; recover funds from the 24 words.                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 10. Host hardening checklist

- [ ] Firewall: inbound only 80/443 (and SSH from known addresses); PostgreSQL/Valkey/RPC never public.
- [ ] SSH keys only, no root login; automatic security updates; time sync (NTP).
- [ ] Disk encryption on the DB and signer hosts; encrypted, access-controlled backups.
- [ ] Docker daemon not exposed; no container runs `--privileged`; the Docker socket is mounted nowhere.
- [ ] `deploy/secrets` mode 600, owned by the deploying user; not in git, not in CI logs.
- [ ] Reverse proxy keeps `/health/*` internal and caps body size (provided Caddyfile does).
- [ ] `TRUST_PROXY=true` only when a proxy you control overwrites `X-Forwarded-For`.
- [ ] Separate signer host; its only outbound routes are the database and your nodes.
- [ ] An independent security review before real funds.

## 11. Scaling and high availability

- api: stateless, scale horizontally; rate limits are shared through Valkey.
- worker: run 2+; leases prevent double work; throughput is bounded by chain scan intervals, not CPU.
- signer: single instance by design (per-chain locks protect nonces/coins even if two start, but run one).
- PostgreSQL: a managed service or Patroni/replicas with synchronous replication for no-loss failover. The stack file runs a single instance: fine for a start, a single point of failure for production.
- Valkey: losing it resets rate limits only; nothing financial lives there.

## 12. Kubernetes

Not provided. Map directly: one Deployment each for api and worker, a Job for `migrate` (as a Helm pre-upgrade hook), a StatefulSet or managed service for PostgreSQL, Secrets mounted as files and referenced with `*_FILE`, an Ingress with TLS, NetworkPolicies mirroring the three networks above, and the signer outside the cluster or in a dedicated, isolated node pool.

## 13. What has and has not been verified

Verified in this repository: the production bundle runs with production
dependencies only; configuration built from the compose files validates for both
custody modes; the compose files expose only the proxy, are read-only, drop all
capabilities and keep secrets in files (unit tests); the application database
role works and cannot alter or erase history (integration tests); the app fails
closed with no configuration.

**Not** verified here: `docker build`, `docker compose up`, Caddy certificate
issuance, PostgreSQL role creation by the init script, real nodes on mainnet, backups
and restore, high availability, and any load testing. Those are your staging checks.
