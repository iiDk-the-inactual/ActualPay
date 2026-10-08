# Security Model: Identity and Access (Phase 2)

This document describes how ActualPay authenticates people and integrations
and decides what they may do. The full threat model arrives in Phase 12.

## Principals

| Principal    | Credential                                                                                      | Where accepted                                       |
| ------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| User session | Opaque 256-bit token in an `HttpOnly`, `SameSite=Strict` cookie (`__Host-` prefixed over HTTPS) | Dashboard and account endpoints                      |
| API key      | `Authorization: Bearer apk_<live\|test>_<publicId>_<secret>`                                    | Organization endpoints marked as integration-capable |

A request carries one or the other, never both. API keys are rejected on
session-only endpoints (account settings, members, keys, invitations).

## Secrets at rest

| Secret                                                                            | Storage                                                                                                         |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Passwords                                                                         | Argon2id (19 MiB, t=2, p=1), PHC string; transparently re-hashed when parameters change                         |
| Session tokens, API key secrets, email/reset/MFA-challenge tokens, recovery codes | SHA-256 of a 256-bit random value                                                                               |
| TOTP seeds                                                                        | AES-256-GCM with a key derived (HKDF) from `ENCRYPTION_KEY`; ciphertext bound to the user id as associated data |

A database dump therefore yields no usable sessions, keys or reset links.
Losing `ENCRYPTION_KEY` disables everyone's TOTP (users fall back to
recovery codes, or an admin resets MFA); it does not expose anything.

Rotating `SESSION_SECRET` invalidates CSRF tokens only (clients re-fetch
them from `GET /v1/me`); sessions and API keys keep working.

## Authentication flows

**Registration** always returns `202`. A new address gets a verification
link; an existing address gets a notice instead. Responses are identical,
so the API cannot be used to enumerate accounts. Sign-in requires a
verified email.

**Login** costs the same Argon2 work for unknown emails (a dummy hash is
verified), and every failure returns the same message. After
`LOGIN_MAX_FAILURES` wrong passwords the account is locked for
`LOGIN_LOCK_MINUTES`, even for the correct password. The lock lives in
PostgreSQL, so it holds even if Redis is down.

**Two-factor (TOTP)** enrolment is two-step (setup → confirm with a code).
Confirming returns ten recovery codes once, upgrades the current session
to MFA-verified and signs out all other sessions. At login, a 5-minute
challenge token is issued; it allows 5 attempts and is single-use. Each
TOTP time step is accepted once (replay protection), and each recovery
code works once.

**Password reset** links expire in 30 minutes, are single-use, and only
the newest link works. Completing a reset revokes all sessions. Changing a
password requires the current one and revokes other sessions.

**One-time links** put the token in the URL fragment (`#token=…`), which
browsers never send to servers, so tokens stay out of access logs and
`Referer` headers.

## Sessions

Idle timeout `SESSION_IDLE_MINUTES` (sliding), absolute lifetime
`SESSION_ABSOLUTE_HOURS`. Users can list and revoke their sessions.
Password reset/change, MFA changes and logout revoke sessions server-side.

## CSRF

Cookies are `SameSite=Strict`. In addition, every state-changing request
authenticated by cookie must carry `X-CSRF-Token`, an HMAC of the session
id that other origins cannot obtain. API-key requests carry no cookies and
are not subject to CSRF.

## Authorization

Every organization-scoped endpoint is declared with `defineRoute`, which
cannot be bypassed and checks, in order: authentication, CSRF, organization
access, permission, input validation, idempotency. Handlers only run after
all checks pass, and responses are filtered through an explicit schema.

- Non-members receive `404`, exactly like a nonexistent organization, so
  ids cannot be probed.
- Suspended organizations are read-only for members and closed to API keys.

### Roles

| Permission                                                                          | owner | admin | finance | developer | viewer | API key scope |
| ----------------------------------------------------------------------------------- | :---: | :---: | :-----: | :-------: | :----: | :-----------: |
| org:read                                                                            |   ✓   |   ✓   |    ✓    |     ✓     |   ✓    |               |
| org:update, settings:manage                                                         |   ✓   |   ✓   |         |           |        |               |
| member:read                                                                         |   ✓   |   ✓   |    ✓    |     ✓     |   ✓    |               |
| member:manage                                                                       |   ✓   |   ✓   |         |           |        |               |
| apikey:read, apikey:manage                                                          |   ✓   |   ✓   |         |     ✓     |        |               |
| audit:read                                                                          |   ✓   |   ✓   |    ✓    |           |        |               |
| invoice:read, payment:read, wallet:read, ledger:read, withdrawal:read, webhook:read |   ✓   |   ✓   |    ✓    |     ✓     |   ✓    |       ✓       |
| invoice:create                                                                      |   ✓   |   ✓   |    ✓    |     ✓     |        |       ✓       |
| invoice:cancel                                                                      |   ✓   |   ✓   |    ✓    |           |        |       ✓       |
| withdrawal:create                                                                   |   ✓   |   ✓   |    ✓    |           |        | ✓ (see below) |
| withdrawal:approve, wallet:manage                                                   |   ✓   |   ✓   |         |           |        |               |
| webhook:manage                                                                      |   ✓   |   ✓   |         |     ✓     |        |       ✓       |

Additional rules, enforced in the service layer:

- Only owners can grant, change or remove the owner role.
- Every organization keeps at least one owner (also a deferred database
  constraint, so no code path can violate it).
- Anyone can leave an organization, subject to the last-owner rule.

### API keys

- Shown once; stored as a SHA-256 hash; listed by non-secret prefix.
- Scopes must be a subset of the creator's own permissions.
- `withdrawal:create` keys require an owner/admin whose current session
  passed two-factor authentication.
- Keys are bound to one organization and one network mode (`live`/`test`).
- Rotation issues a replacement and keeps the old key alive for a grace
  period (0–168 h). Revocation is immediate. Keys are never deleted.

## Idempotency

`POST` endpoints that create resources accept `Idempotency-Key`. A repeat
with the same body within 24 h replays the original response
(`Idempotent-Replayed: true`); a repeat with a different body is rejected
with `IDEMPOTENCY_KEY_REUSED`; a concurrent duplicate receives `409`.
Validation failures are recorded too; 5xx failures release the key.
Money-moving operations are additionally idempotent at the database level
(see docs/ledger.md), because the key claim and the business transaction
are separate commits.

## Rate limiting and Redis

| Bucket                   | Default | Key                                      |
| ------------------------ | ------- | ---------------------------------------- |
| Authentication endpoints | 10/min  | client IP                                |
| General API              | 600/min | API key public id, else session, else IP |

Limits are shared through Redis/Valkey. **If Redis is unavailable, limits
fall back to per-instance in-memory counters** instead of switching off: with
N API instances an attacker gets at most N× the configured rate, never
unlimited. Shared counting resumes automatically when Redis returns, and a
warning is logged at most once a minute while degraded. Account lockout and
all financial safety checks live in PostgreSQL and are unaffected.
`/health/ready` reports Redis status but does not fail on it.

Behind a reverse proxy, set `TRUST_PROXY=true` so limits apply to the real
client IP, and make sure the proxy overwrites `X-Forwarded-For`.

## HTTP hardening

JSON-only bodies (100 KB max), prototype-poisoning rejection, strict
security headers (`default-src 'none'`, `frame-ancestors 'none'`, `nosniff`,
HSTS in production), `Cache-Control: no-store`, server-generated request
ids (client-supplied ids are ignored), and a single error envelope that
never contains stack traces outside development.

## Audit trail

Security-relevant actions write an append-only audit record in the same
transaction as the change: registration, verification, login success and
failure, logout, password reset/change, MFA enable/disable, recovery-code
use, session revocation, organization changes, membership and role
changes, invitations, API key creation/rotation/revocation. Metadata is
sanitised so secrets cannot be written even by mistake.

## Known gaps (tracked for later phases)

- No breached-password check (e.g. k-anonymity lookup) yet.
- No WebAuthn/passkeys yet; TOTP only.
- Organization-level "require 2FA for all members" policy: Phase 9.
- Platform-admin API surface (and its mandatory 2FA): Phase 9.
- Fallback counters are not merged back into Redis on recovery, so a
  client can get roughly one extra window during the transition.
- Expired session/token/idempotency rows are not yet purged: cleanup jobs
  arrive with the job system in Phase 6.
