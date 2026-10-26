# Withdrawals and the signer

Phase 8. This is the part of ActualPay that can lose money, so it is built to
fail closed: when anything is unclear it stops and asks a human.

**Test networks and local chains only until an independent audit says otherwise.**
Nothing here has been audited.

## Custody modes

`CUSTODY_MODE` decides who holds the money.

| Mode                 | Who holds funds                             | Withdrawals                                                                          |
| -------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| `merchant` (default) | Each merchant, in wallets only they control | None. Payments go straight to the merchant's own addresses; ActualPay holds no keys. |
| `platform`           | The operator, in one hot wallet per chain   | Merchants request payouts; the operator's signer pays them.                          |

Merchant mode is the safe default and the recommended one. Platform mode makes
the operator a custodian: legal and regulatory obligations apply that this
software cannot discharge for you.

In platform mode organizations cannot register their own deposit wallets
(administrators do, via `/v1/admin/...`); otherwise a merchant could be credited
for money the platform never received.

## Money flow

1. **Request** (`POST /v1/organizations/:org/withdrawals`): policy checks run and
   the amount is moved from the merchant's available balance to a hold account,
   in one transaction. Funds cannot be spent twice.
2. **Approve** (`.../approve`): a _different_ person with the approve permission and
   two-factor authentication approves. The database refuses an approval by the
   requester (`withdrawals_no_self_approval`). Approval stamps an HMAC **seal**
   over the exact terms (organization, asset, amount, destination, chain,
   expiry), keyed by `WITHDRAWAL_SEAL_KEY`, which is _not_ stored in the database.
3. **Sign** (signer process): re-verifies everything independently (below),
   builds and signs the transaction, re-parses its own signed bytes, and stores
   the signed transaction and its id **before** anything is broadcast.
4. **Broadcast / track** (worker): sends the stored transaction (idempotent),
   follows it to finality, then settles the ledger with the real network fee.
5. Reverted on chain: the hold is released and the fee is booked as a loss
   (`postWithdrawalFailedFee`). Anything uncertain moves the withdrawal to
   `needs_review` and opens a critical issue; the hold is never auto-released.

Approvals expire (`WITHDRAWAL_APPROVAL_TTL_MINUTES`); expired ones release the hold.

## Controls

- **Deny by default.** No withdrawals for an asset without an enabled policy
  (minimum, per-withdrawal maximum, daily maximum).
- **Policies are versions.** Tightening is immediate. Loosening takes effect only
  after `WITHDRAWAL_POLICY_INCREASE_DELAY_HOURS`, so a hijacked account cannot
  raise the limit and drain in one sitting. Loosening is judged against the newest
  version, pending or not, so it cannot be staged in small steps.
- **Destination allowlist.** Withdrawals go only to pre-registered addresses
  usable after `WITHDRAWAL_DESTINATION_COOLDOWN_HOURS`. Revoking is immediate.
- **Four eyes + MFA** on approval; MFA also on policy, destination and all admin routes.
- **Kill switch.** `POST /v1/admin/withdrawals/pause` stops requesting, approving
  and signing at once. `resume` re-enables.
- **Hot wallet registry.** The signer only pays from addresses an administrator
  registered; one active per chain and network.

## What the signer re-checks (it trusts nothing the API says)

Not paused; approval not expired; seal valid under the signer's own key; approver
still has the role and MFA; ledger hold exists, equals the amount, and is not
released; destination exists, is not revoked, is past its cool-down and matches;
policy still allows it; hot wallet registered, active and the one this keystore
controls; fee-rate / gas-price caps (500 gwei, 500 sat/vB); fee no more than 10%
of the amount; balance sufficient (ETH for gas, token balance for ERC-20, only
confirmed coins for UTXO chains). Any failure refuses signing and records why;
the withdrawal stays `approved` (and will expire) or is handled by a human.

A signer takes a per-chain lock while signing so nonces and coins are never reused.

### Honest limits of the seal

The seal stops someone who can edit the database (or a compromised API) from
changing approved terms. It does **not** protect against a full compromise of the
API host _and_ the seal key. Run the signer on a separate, locked-down machine
holding the keystore and the seal key; the API host needs the seal key only to
create seals, so a stricter deployment may split that role (future work).

## Keystore

`npm run signer:init` generates a 24-word BIP39 mnemonic, shown **once**, and
writes an encrypted keystore (AES-256-GCM, key from scrypt; addresses are
authenticated data so a swapped file is detected). The passphrase comes from
`SIGNER_PASSPHRASE` or `SIGNER_PASSPHRASE_FILE`. Paths: BTC `m/84'/0'/0'/0/0`
(testnet coin 1), LTC coin 2, ETH `m/44'/60'/0'/0/0`. Keys are software keys; an
HSM or KMS is the replacement point (`packages/signer/src/keystore.ts`).

Supported withdrawal assets: BTC, LTC, ETH, USDT (ERC-20). **Not supported:** XRP
and TRON. Transactions are hand-built (EIP-1559 and P2WPKH/BIP143) and checked
against Anvil and Bitcoin Core regtest; no other wallet library signs for you.

## Operator runbook

1. Set `CUSTODY_MODE=platform`, `WITHDRAWAL_SEAL_KEY` (`openssl rand -base64 32`),
   cool-down and delay of 24h or more in production.
2. On the signer host: `npm run signer:init`; write the 24 words on paper, store
   offline in two places; `npm run signer:addresses` prints the hot addresses.
3. As an MFA-enabled platform administrator: `POST /v1/admin/hot-wallets` for each chain.
4. Fund the hot wallets with a small amount first. Withdrawals pay from them; fees
   come out of custody, so also record gas you add with
   `POST /v1/admin/platform-funding` (otherwise the books cannot absorb a fee
   and settlement blocks with a critical issue).
5. Run `npm run signer:start` (one instance) and the worker with chain nodes configured.
6. Watch `GET /v1/admin/status` and `/v1/admin/issues`; alert on critical issues.

### When it goes wrong

- **Emergency:** pause withdrawals first, investigate second.
- `needs_review`: a human checks the chain for the txid, then resolves the issue.
  The hold is never released automatically.
- **Dropped signed transaction (EVM nonce gap):** the signer does not replace
  transactions. Resolve manually (re-broadcast, or send a replacement from the
  same nonce with another tool) before signing more.
- **`withdrawal_settlement_blocked`:** custody lacks funds to book the fee; record platform funding.
- **BTC change** cannot be respent until confirmed (only confirmed coins are used).

## Known gaps

No on-chain balance reconciliation of the hot wallet against the ledger yet;
no HSM; the seal key lives with the API host; XRP/TRON payouts; no fiat
limits. An independent security review is required before real funds.
