# Webhooks (Phase 7)

ActualPay tells your server when something happens by sending an HTTPS `POST` to
an endpoint you register. This page is both the design and the receiver guide.

## Events

| Event                    | When                                                         |
| ------------------------ | ------------------------------------------------------------ |
| `invoice.created`        | an invoice was created                                       |
| `invoice.processing`     | a payment was seen but is not final                          |
| `invoice.partially_paid` | confirmed money, but less than due                           |
| `invoice.paid`           | confirmed ≥ the amount due (check `paidLate`)                |
| `invoice.expired`        | time ran out with nothing in flight                          |
| `invoice.cancelled`      | the merchant cancelled an unpaid invoice                     |
| `invoice.reopened`       | a paid invoice went back (a deep reorg reversed its payment) |
| `payment.detected`       | a transfer to an invoice address was seen                    |
| `payment.confirmed`      | the transfer is final and credited to your balance           |
| `payment.reversed`       | the transfer left the chain; any credit was reversed         |
| `withdrawal.*`           | withdrawal lifecycle (Phase 8)                               |
| `webhook.test`           | sent only by the "send test event" button                    |

An endpoint subscribes to specific events or to `*` (all).

## What you receive

```
POST /your/path
Content-Type: application/json
User-Agent: ActualPay-Webhooks/1
ActualPay-Event-Id: evt_123
ActualPay-Event-Type: invoice.paid
ActualPay-Delivery-Id: 6f1c…
ActualPay-Delivery-Attempt: 1
ActualPay-Signature: t=1790000000,v1=9b2e…

{"id":"evt_123","type":"invoice.paid","createdAt":"2026-…Z",
 "organizationId":"…","subject":{"type":"invoice","id":"…"},
 "data":{ …the invoice or payment as the API returns it… }}
```

## Verify every request

The signature is `HMAC-SHA256(secret, "<t>.<raw body>")`, hex-encoded, where `t`
is the timestamp in the header. **Verify against the raw bytes of the body**
(not re-serialised JSON), compare in constant time, and reject a timestamp more
than 5 minutes old to stop replays.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(header, rawBody, secret, toleranceSeconds = 300) {
  const parts = header.split(',');
  const t = Number(parts.find((p) => p.startsWith('t='))?.slice(2));
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return parts
    .filter((p) => p.startsWith('v1='))
    .some((p) => {
      const got = Buffer.from(p.slice(3), 'hex');
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
}
```

During a secret rotation the header carries **two** `v1=` values, one per active
secret, so you can switch secrets with no downtime: deploy the new secret, then
the old one stops being used after 24 hours.

## Delivery guarantees

- **At least once.** The same event can arrive more than once. De-duplicate on
  `ActualPay-Event-Id` and make your handler idempotent.
- **Not ordered.** Events can arrive out of order, especially around retries.
  Use `createdAt`, or fetch the current invoice from the API, rather than
  assuming sequence.
- **Answer quickly with a 2xx.** Anything else counts as a failure: other
  status codes, redirects (never followed), timeouts (10 s), connection, DNS or
  TLS errors. Do the work after you respond.
- **Retries** wait 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, 4 h, 8 h, 12 h and
  24 h after each failure (11 attempts, about two days), then the delivery is
  marked `failed`. You can re-send it (`POST …/webhook-deliveries/:id/redeliver`).
- **`410 Gone`** disables the endpoint immediately. **50 failures in a row**
  disable it too (re-enable with `PATCH … {"status":"active"}`); the reason is
  shown on the endpoint and written to the audit log.
- If your endpoint is down for longer than the retry window, list missed events
  from the API and reconcile; webhooks are a notification, the API is the record.

## How it is built, and why it is safe

- **Written with the change.** A delivery row is created in the _same database
  transaction_ as the event it announces (`recordEvent`). A webhook therefore
  exists if and only if the change committed: none lost on a crash, none sent
  for a rolled-back change. The worker only sends what is already recorded.
- **Secrets.** The signing secret (`whsec_…`, 256 bits) is shown once, at
  creation and at rotation. Because ActualPay must sign with it, it is stored
  **encrypted** (AES-256-GCM, bound to the endpoint id), never in clear, and
  never appears in the API, logs or audit trail.
- **SSRF protection.** A webhook URL makes _our_ servers send a request, so it
  is attacker-controlled input. Rules, checked when you register or change a URL
  _and again on every delivery_: https only; no credentials in the URL; no
  loopback, private, link-local (including the cloud metadata address
  169.254.169.254), carrier-grade NAT, multicast or reserved ranges in IPv4,
  IPv6, IPv4-mapped, NAT64 or 6to4 form; no `localhost`/`.local`/`.internal`
  style names. Host names are resolved at delivery time by our own resolver and
  the socket connects to the address that was checked, so a name that turns
  private after registration (DNS rebinding) is refused. If _any_ resolved
  address is forbidden, the delivery is refused, even if another is public.
  Redirects are never followed. Response bodies are never stored or trusted;
  errors are recorded only as short fixed phrases ("HTTP 500", "timeout").
- **Claims.** Workers claim deliveries with `FOR UPDATE SKIP LOCKED` and a short
  lock, so two workers never send the same delivery at once (tested with four
  racing workers).
- **Limits.** 20 endpoints per organization, 256 KiB payloads, 40 event types.

## Settings

`WEBHOOK_ALLOW_HTTP` and `WEBHOOK_ALLOW_PRIVATE_NETWORKS` (both default `false`)
exist for local development, so a receiver on `http://localhost` works. The
configuration **refuses to start in production** with either set.

## Not covered (yet)

- Email notification to the organization when an endpoint is auto-disabled
  (Phase 10 adds email; today it is on the endpoint and in the audit log).
- Automatic purging of old delivery rows (a retention policy is an operator
  decision; see MANUAL-STEPS.md).
