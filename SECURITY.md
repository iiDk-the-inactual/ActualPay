# Security Policy

> **Status:** ActualPay is pre-release (Phase 3 of 13). It does not yet
> process payments and must not be used with real funds.

## Reporting a vulnerability

**MAINTAINER: configure a private reporting channel before publishing**
(for example, GitHub private vulnerability reporting for this repository).
Until then there is no security contact, and this file intentionally does not
list a placeholder email address.

Please do not open public issues for vulnerabilities.

## Supported versions

No version is supported for production use yet.

## Security model (summary)

See `docs/architecture.md` for the custody model and the correctness
mechanisms, and `docs/security-model.md` for authentication and access control. A complete threat model is delivered in Phase 12.

Key principles already enforced in code:

- Exact integer arithmetic for all amounts; floats are lint-banned.
- Append-only, database-enforced ledger and audit log.
- Database-level idempotency for every financial event.
- Configuration fails closed; production rejects testnet, plain HTTP,
  debug logging and placeholder secrets.
- Secrets are never logged and can be supplied via `*_FILE`.
