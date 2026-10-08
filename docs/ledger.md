# Ledger

ActualPay keeps its own double-entry ledger. Blockchain balances are an
_input_ to reconciliation, not the accounting system.

## Rules

1. Amounts are positive `bigint` base units with an explicit direction
   (`debit` or `credit`).
2. Every journal has at least two entries and balances **per asset**:
   Σ debits = Σ credits. One journal may balance in two assets (a USDT
   withdrawal whose network fee is paid in ETH).
3. Journals and entries are never updated or deleted. Mistakes are corrected
   with a `reversal` (exact mirror, linked to the original, at most one per
   journal) or an `adjustment`.
4. Each journal has a unique `external_ref`. Posting the same reference again
   is a no-op if the content matches and an error if it does not.
5. Postings run inside the same database transaction as the business change
   they account for.

## Chart of accounts

| Type                  | Owner        | Normal side | May go negative | Meaning                                  |
| --------------------- | ------------ | ----------- | --------------- | ---------------------------------------- |
| `custody`             | platform     | debit       | no              | Coins the platform holds on-chain        |
| `network_fees`        | platform     | debit       | no              | Fees paid to miners/validators (expense) |
| `platform_revenue`    | platform     | credit      | no              | Fees charged to merchants                |
| `suspense`            | platform     | debit       | yes             | Unexplained differences awaiting review  |
| `org_available`       | organization | credit      | no              | Withdrawable merchant balance            |
| `org_withdrawal_hold` | organization | credit      | no              | Reserved by in-flight withdrawals        |

An account's balance increases when an entry's direction equals its normal side.

**Solvency invariant**, per asset (checked by `verifyLedgerIntegrity`):
Σ debit-normal balances − Σ credit-normal balances = 0.

## Postings

| Event                | Reference                    | Lines                                                                                                                 |
| -------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Deposit confirmed    | `deposit:<chain-output-ref>` | Dr custody / Cr org_available                                                                                         |
| Withdrawal requested | `withdrawal:<id>:hold`       | Dr org_available / Cr org_withdrawal_hold (amount + fee)                                                              |
| Withdrawal cancelled | `withdrawal:<id>:release`    | Dr org_withdrawal_hold / Cr org_available                                                                             |
| Withdrawal final     | `withdrawal:<id>:settled`    | Dr hold (amount+fee) / Cr custody (amount) / Cr platform_revenue (fee); Dr network_fees / Cr custody in the fee asset |
| Deposit reorged out  | `reversal` of the deposit    | Mirror of the original                                                                                                |

Chain output references must be unique and stable:
`btc:<txid>:<vout>`, `ltc:<txid>:<vout>`, `eth:<txhash>:native`,
`eth:<txhash>:<logIndex>`, `trx:<txid>:<index>`, `xrp:<txhash>`.

## What happens when a reversal is impossible

If a deposit is reorged out after the merchant already withdrew the funds,
the reversal fails with `INSUFFICIENT_BALANCE`. This is intentional: the
platform has a real loss, and an operator must decide how to book it (for
example, through `suspense`) as an explicit, audited adjustment.

## Concurrency

`postJournal` locks every touched account (`SELECT … FOR UPDATE`, ordered by
id to prevent deadlocks), checks resulting balances, then writes. The
`CHECK (balance >= 0)` constraint is the backstop. The integration suite
fires 20 concurrent withdrawals at a balance that covers 3 and asserts that
exactly 3 succeed.
