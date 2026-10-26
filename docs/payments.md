# Invoices, payments and payment links (Phase 5)

## Concepts

- **Invoice.** A request for an exact amount of one asset. Creating it
  allocates a fresh deposit address from one of the organization's confirmed
  wallets (docs/wallets.md). The address belongs to that invoice for ever.
- **Payment.** One on-chain credit to an invoice's address, identified by the
  chain's own reference (`btc:<txid>:<vout>`, `eth:<txhash>:native`,
  `eth:<txhash>:<logIndex>`, `xrp:<txhash>`…). Seeing the same transfer a
  hundred times produces one payment.
- **Payment link.** A fixed-price reusable page. Each visitor gets their own
  invoice (and so their own address).

## Money and the ledger

Amounts are `bigint` base units internally and decimal strings at the API
(`"0.0015"`), parsed strictly: no rounding, no exponents, no more decimals than
the asset has. Responses carry both forms: `{ asset, amount, baseUnits }`.
**There is no fiat pricing.** Invoices are denominated in the crypto asset;
converting a price in dollars is the merchant's job (see the manual steps).

| Payment state | Meaning                                 | Ledger                                                   |
| ------------- | --------------------------------------- | -------------------------------------------------------- |
| `pending`     | seen, not final yet                     | nothing                                                  |
| `confirmed`   | the chain's finality rule is met        | `Dr custody / Cr org_available` (ref `deposit:<ref>`)    |
| `reversed`    | no longer on the chain (reorg/replace)  | exact mirror reversal if it had been credited            |
| `pending`     | the reorged transaction was mined again | a new credit with its own reference (`deposit:<ref>:e2`) |

Only `confirmed` payments move money. Finality is the chain adapter's rule
(docs/chains.md), not a number invented here.

Money received in a **different asset** than the invoice's (ETH sent to a USDT
invoice address) is credited to the merchant, because the coins are really in
custody, but does not count toward the invoice. It is visible on the invoice
with `countsTowardInvoice: false`.

## Invoice states

Status is never set by hand. It is recomputed from the invoice's payments, its
expiry and its cancellation every time any of them changes
(`deriveInvoiceStatus`, a pure function with an exhaustive test table):

| Status           | When                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| `paid`           | confirmed ≥ amount due. Always wins, even after expiry or cancellation |
| `cancelled`      | the merchant cancelled before any payment                              |
| `processing`     | a payment has been seen but is not final                               |
| `expired`        | time is up and nothing is in flight                                    |
| `partially_paid` | some confirmed money, less than due, still in time                     |
| `open`           | nothing received                                                       |

Consequences worth knowing:

- **Late payments are accepted.** A full payment confirmed after expiry still
  completes the invoice, with `paidLate: true`. Whether the merchant honours it
  is a business decision; the money is theirs either way.
- **Overpayment** completes the invoice; the excess is credited to the
  merchant's balance.
- **`paid` can be undone.** A reorg deeper than the chain's finality (rare)
  reverses the payment and the invoice reopens (`invoice.reopened` event).
- **A payment in flight keeps an expired invoice `processing`** until it
  resolves.
- **Cancel** is allowed only while nothing has been received.

## Safety properties (database level)

- One address, one invoice (unique index); a payment's chain reference is
  unique; payments can only move `pending → confirmed → reversed` (and back to
  `pending`); payment identity, amount and an invoice's amount, asset and
  address are immutable; invoices, payments and events cannot be deleted.
- Concurrent observers of one transfer serialize on the invoice row and then on
  the ledger's unique reference: credited exactly once (12-way race test).
- A confirmed payment always points at its ledger journal.
- A reversal that the books cannot absorb (the merchant already withdrew the
  money) fails with `INSUFFICIENT_BALANCE` and changes nothing. That is a real
  loss an operator must book (docs/ledger.md); Phase 6 raises it as a
  reconciliation issue.

## Limits against abuse

Each invoice uses one address permanently, and payment links are public, so:

- per payment link: at most `maxOpenInvoices` unpaid invoices at once
  (default 20, max 500), enforced under an advisory lock;
- per organization: at most 5,000 unpaid invoices;
- `POST /v1/public/payment-links/:publicId/invoices` uses the strict per-IP
  rate limit (`RATE_LIMIT_AUTH_PER_MINUTE`);
- public ids are 192-bit random values; the internal id is never accepted on
  public routes, and the public views never show `externalId`, `metadata` or
  any internal field.

## API

| Method and path                                                             | Who                              |
| --------------------------------------------------------------------------- | -------------------------------- |
| `POST /v1/organizations/:orgId/invoices`                                    | key or session, `invoice:create` |
| `GET  /v1/organizations/:orgId/invoices[/:invoiceId]`                       | `invoice:read`                   |
| `POST /v1/organizations/:orgId/invoices/:invoiceId/cancel`                  | `invoice:cancel`                 |
| `GET  /v1/organizations/:orgId/payments`                                    | `payment:read`                   |
| `POST/GET /v1/organizations/:orgId/payment-links`, `…/:linkId/(de)activate` | session only                     |
| `GET  /v1/public/invoices/:publicId`                                        | public                           |
| `GET  /v1/public/payment-links/:publicId`                                   | public                           |
| `POST /v1/public/payment-links/:publicId/invoices`                          | public, strict rate limit        |

Creating an invoice with an `externalId` is idempotent: repeating it returns
the original invoice; reusing the id with a different amount or asset is a 409.
Use the `Idempotency-Key` header as well for network-level retries.

## Domain events

Every change writes an append-only row to `domain_events` in the same
transaction (`invoice.created`, `.processing`, `.partially_paid`, `.paid`,
`.expired`, `.cancelled`, `.reopened`, `payment.detected`, `.confirmed`,
`.reversed`). Webhooks (Phase 7) deliver from this table, so an event exists if
and only if the change committed.

## Not in this phase

Watching the chain and feeding `recordObservation` (Phase 6); the expiry
sweep running on a schedule (Phase 6; `expireInvoices` is ready); hosted
pages (Phase 9); fiat pricing and fees (see MANUAL-STEPS.md).
