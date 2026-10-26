# API guide

The authoritative reference is the generated OpenAPI document:

- **`docs/openapi.json`** in the repository (checked by a test, so it cannot drift), and
- **`GET /v1/openapi.json`** on a running server (public, no secrets in it).

Load either into Swagger UI, Postman, `openapi-generator` or similar. Regenerate
the file after changing a route with `npm run openapi:generate`. This guide
covers what the reference cannot: how things fit together.

## Authentication

| Caller               | How                                                                     | Can do                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Your server          | `Authorization: Bearer apk_live_…` (or `apk_test_…` on testnet)         | Only the scopes the key was given: create and read invoices, read payments and wallets, create withdrawals, manage webhooks |
| A person (dashboard) | Session cookie from `POST /v1/auth/login` plus `X-CSRF-Token` on writes | Everything their role allows                                                                                                |

API keys can **not** manage members or other keys, approve withdrawals, change
withdrawal limits or destinations, or call `/v1/admin/*`. Those need a signed-in
person, several of them with two-factor authentication. Create a key under
Dashboard → API keys; the secret is shown once. Give each integration its own key
with the fewest scopes it needs, and rotate on any suspicion.

Test keys (`apk_test_…`) exist only when `NETWORK_MODE=testnet`; a key never
works across modes.

## Money

Amounts are **decimal strings** (`"0.015"`), never numbers, in the asset's own
unit (BTC, ETH, USDT…). Responses give `{ "asset", "amount", "baseUnits" }`;
`baseUnits` is the exact integer (satoshi, wei…) as a string. Never parse
amounts as floats.

## Creating and watching an invoice

```sh
curl -sS https://pay.example.com/v1/organizations/$ORG/invoices \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: order-1042" \
  -d '{"asset":"eth","amount":"0.05","externalId":"order-1042","description":"Order 1042"}'
```

The response contains `hostedUrl` (send the customer there), the deposit
`address`, and the status. Then either poll `GET …/invoices/:id` or, better,
register a webhook (see `docs/webhooks.md`) and wait for `invoice.paid`. Only
treat an invoice as paid when its status is `paid` (it already waits for the
chain's confirmations and is rolled back if a reorganization removes the payment).

Statuses: `open`, `processing` (seen, not yet final), `partially_paid`, `paid`,
`expired`, `cancelled`. Late payments to an expired invoice are still recorded and
flagged `paidLate`; they never disappear.

## Idempotency

Creating calls accept an `Idempotency-Key` header (1–255 characters of
`A–Z a–z 0–9 _ - . :`). Repeating the same request with the same key returns the
original response; the same key with a different body fails with
`IDEMPOTENCY_KEY_REUSED` (422); a simultaneous duplicate gets `409`. Use a key
derived from your own record (the order id), not a random value per attempt.
`externalId` additionally de-duplicates invoices by your reference.

## Pagination

List endpoints take `limit` (1–200, default 50) and `cursor`, and return
`{ "data": [...], "nextCursor": "…" | null }`, newest first. Pass `nextCursor` back
unchanged; cursors are opaque and signed against tampering by structure checks.

## Errors

Every failure is `{ "error": { "code", "message", "requestId", "details"? } }`.
Quote `requestId` when asking for help; it is also the `X-Request-Id` response header.

| HTTP      | Codes                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------ |
| 400       | `VALIDATION_FAILED` (details list the fields)                                                          |
| 401       | `UNAUTHENTICATED`                                                                                      |
| 403       | `FORBIDDEN`, `CSRF_FAILED`, `MFA_REQUIRED`, `EMAIL_NOT_VERIFIED`, `ORGANIZATION_SUSPENDED`             |
| 404       | `NOT_FOUND` (also returned for other organizations' objects)                                           |
| 409       | `CONFLICT`, `INVALID_STATE_TRANSITION`                                                                 |
| 413 / 415 | `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` (bodies must be `application/json`)                      |
| 422       | `IDEMPOTENCY_KEY_REUSED`, `INSUFFICIENT_BALANCE`                                                       |
| 429       | `RATE_LIMITED` (back off; `RATE_LIMIT_API_PER_MINUTE` defaults to 600, authentication endpoints to 10) |
| 5xx       | `INTERNAL`, `UPSTREAM_UNAVAILABLE`, `LEDGER_UNBALANCED` (the last means stop and investigate)          |

Retry only on `429`, `503` and network errors, always with the same
`Idempotency-Key`.

## Webhooks

Prefer webhooks to polling. Events, signatures, retry schedule and the receiver
checklist are in `docs/webhooks.md`. Verify the signature on the **raw** body
and deduplicate by event id.

## Withdrawals (platform custody mode only)

`POST …/withdrawals` holds the funds and creates a request. A different person
with two-factor authentication approves it in the dashboard; the signer then
pays it. API keys with the `withdrawal:create` scope can request but never
approve. See `docs/withdrawals.md`. In the default merchant mode these endpoints
answer `409`.

## Versioning and stability

Paths are under `/v1`. Within `v1` fields may be added; existing fields keep their
meaning. Ignore unknown fields in responses. Breaking changes would ship as `/v2`.
The API is still pre-release until the project says otherwise.
