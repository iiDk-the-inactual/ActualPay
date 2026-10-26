# Threat model

Phase 12. This document says what ActualPay defends, against whom, how, and
what it does **not** defend. It is a design review by the authors, not an
independent audit. **Do not run it with real funds until an independent security
review has been done** (see "Before real funds").

## What is protected, in order of importance

1. **Funds**: coins in the platform hot wallets (platform custody mode only).
2. **Ledger truth**: the books must always say what each organization is owed.
3. **Keys and secrets**: keystore, seal key, encryption key, session secret, API keys, webhook secrets.
4. **Merchant data and account access**: organizations, API keys, sessions.
5. **Availability** of payment detection and settlement.

In the default **merchant custody** mode (no withdrawals, funds go directly to
merchant wallets using public keys only) category 1 does not exist in this
software: a total compromise can mislead payers and corrupt records, but cannot
move merchant funds. That is why it is the default and recommended mode.

## Actors

| Actor                        | Assumed capability                                                     |
| ---------------------------- | ---------------------------------------------------------------------- |
| Anonymous internet user      | Any HTTP request; the public pay pages and public endpoints            |
| Malicious payer              | Pays wrong amounts, late, twice, from exchanges, from a contract, dust |
| Malicious merchant user      | A legitimate account trying to reach another tenant or raise limits    |
| Compromised merchant account | Stolen password/session/API key                                        |
| Malicious webhook receiver   | Our outbound requests go to their URL                                  |
| Chain-level adversary        | Reorgs, forged or delayed node answers, a hostile RPC provider         |
| Compromised API host         | Code execution in the API/worker (not the signer host)                 |
| Insider with DB access       | Can write SQL                                                          |
| Malicious dependency         | Supply-chain code in a package we depend on                            |

Out of scope: a fully compromised signer host with the unlocked keystore, a
compromised operator workstation, physical access, coercion, the security of the
chains themselves, and legal/regulatory obligations of a custodian.

## Trust boundaries

```
Internet ─▶ [API (Fastify)] ─▶ PostgreSQL ◀─ [worker] ─▶ chain nodes, SMTP, webhook receivers
                                  ▲
                                  └──── [signer] (separate host; reads DB, never listens, never broadcasts)
```

The signer trusts **only** the database state it re-verifies and the seal key. It
does not trust the API.

## Threats and controls

### Authentication and sessions

- Credential stuffing / brute force: Argon2id, per-account lockout, per-IP and per-account rate limits, uniform answers for login/forgot/register (tested).
- Session theft: HttpOnly, SameSite=Strict, Secure outside development, absolute and idle expiry, sessions revocable, password change revokes others, CSRF token bound to the session (every unsafe session route tested).
- MFA bypass: TOTP with replay protection, recovery codes hashed; high-risk routes require an MFA-verified session (enforced and tested for every route that declares it).
- Residual: no WebAuthn/passkeys; TOTP is phishable.

### Authorization and tenancy

- Cross-tenant access: every organization route resolves membership first and answers `404` for outsiders so existence is not revealed. **Tested for every route in the registry**, so a new route cannot forget it.
- Privilege escalation: role-to-permission table; API keys have explicit scopes and can never manage members, keys, approvals, destinations, limits or admin (tested against the OpenAPI document).
- Platform administration: `platformAdmin` gate runs before any input is read, plus MFA (tested for all `/v1/admin` routes).

### Input handling

- Injection: Kysely parameterised queries throughout; Zod validation of every input; hostile-input sweep over every route asserts no 5xx.
- Prototype pollution and oversize bodies rejected by the server; 100 KB body limit; only JSON accepted.
- XSS: the dashboard never builds HTML from data (enforced by a test), strict CSP without inline code.
- Request smuggling and slow clients: request/connection/keep-alive timeouts; run behind a reverse proxy that normalises requests.

### Money correctness

- Double credit / double spend: unique `external_ref` on every journal, DB constraints, advisory locks, idempotency keys, hold-before-sign.
- Unbalanced or edited history: append-only triggers; balanced-journal constraint; reconciliation job compares ledger, payments and chain state and opens issues.
- Reorgs: payments are credited only when final per the chain's rule, and rolled back with a circuit breaker; a mass reversal stops and alerts rather than draining.
- Hostile payers: exact-amount accounting, late/over/under payment handling, token contract allowlist (a look-alike token is never credited), per-invoice addresses, XRPL destination tags.
- Residual: `reversal_blocked` means real loss that needs a human; fiat pricing is not implemented (invoices are in crypto units).

### Withdrawals and the signer (platform mode)

- Stolen merchant session: deny-by-default limits; loosening delayed; destinations need a cool-down; a different approver with MFA is required; the DB forbids self-approval; funds are held at request.
- Compromised API host editing the DB: the **seal** (HMAC over amount, destination, chain, expiry, keyed outside the DB) and the signer's own re-verification of approver role+MFA, ledger hold, destination and policy make a forged approved row unsignable unless the attacker also has the seal key.
- Runaway fees: gas/fee caps and a fee-to-amount ratio cap.
- Double broadcast / nonce reuse: per-chain signing lock, nonce and coin tracking, signed transaction persisted before broadcast, idempotent broadcast.
- Emergency: platform-wide pause that stops requests, approvals and signing.
- Residual (important): software keystore; the seal key lives with the API host so **a full compromise of the API host plus the seal key can authorise arbitrary withdrawals within hot-wallet balance**. Mitigate by keeping the hot wallet small, alerting, and moving the seal to a signer-side/HSM design before real volume. No on-chain vs ledger reconciliation of hot wallets yet.

### Webhooks (outbound)

- SSRF: https only, resolved IP checked and connected to (no DNS rebinding), private/link-local/metadata ranges refused, no redirects, checked at registration **and** delivery, short timeouts and response size caps; the unsafe flags are refused in production.
- Forgery by third parties: HMAC-SHA256 with timestamp and secret rotation.
- Receiver misbehaviour: bounded retries, auto-disable, no receiver response text stored.

### Email

- Header and body injection: plain text only, fixed subjects, DB check against CR/LF, user text on its own line.
- Abuse via forwarding: consent by emailed single-use hashed token; MFA, rate limit and audit to create; per-organization daily cap.

### Chain data

- Lying or lagging node: chain ID verified, final-height rules per chain, rechecks of every credited transaction, cursors never advance past unrecorded transfers; use your own nodes in production.

### Supply chain and operations

- Production dependencies audited in CI (`npm audit --omit=dev --audit-level=high`) and license-checked; lockfile committed; Dependabot enabled; Node and zod kept current.
- Secrets never logged (pino redaction), loaded from `*_FILE` where supported, refused if placeholder in production.
- Residual: transitive dependencies can still be malicious; pin and review upgrades of crypto packages (`@noble/*`, `@scure/*`); build in CI from a clean checkout.

### Denial of service

- Rate limits (Redis-backed), body limits, pagination caps, bounded batch sizes, leases so work is not duplicated. Residual: no per-tenant resource quotas; put a WAF/CDN or reverse proxy rate limit in front.

## Security test suite

`tests/integration/security.test.ts` is generated from the route registry and
asserts, for **every** route: unauthenticated → 401; outsider → 404; viewer lacks
→ 403; missing CSRF → 403; declared-MFA routes refuse non-MFA sessions; admin
routes refuse non-admins before reading input; hostile bodies, paths and queries
never cause a 5xx; plus header, cookie, enumeration and error-leak checks.
`tests/integration/openapi.test.ts` fails if an API key can reach a route it must not.
Elsewhere: `withdrawals*.test.ts`, `signer.test.ts` (refusal paths, tamper),
`webhooks.test.ts` (SSRF), `ledger.test.ts` (append-only, balance), `web.test.ts`.

## Before real funds

- [ ] Independent security review/penetration test of the API, signer and keystore.
- [ ] Decide custody mode deliberately; get legal advice if you hold customer funds.
- [ ] Signer on its own hardened host; keystore passphrase and 24 words backed up offline; hot wallet capped.
- [ ] Own full nodes, monitored; alerting on critical issues (`OPERATOR_ALERT_EMAIL` plus external monitoring).
- [ ] Backups of PostgreSQL with restore drills; point-in-time recovery.
- [ ] Reverse proxy with TLS, HSTS, request limits; `TRUST_PROXY` set correctly.
- [ ] Rotate every secret from the examples; set production limits (cool-down, policy delay ≥ 24 h).
