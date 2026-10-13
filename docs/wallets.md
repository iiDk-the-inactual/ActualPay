# Wallets and deposit addresses (Phase 4)

ActualPay is **watch-only** at this stage. A _wallet_ is an account-level
extended **public** key, or for XRPL one receiving account. Nothing here can
spend funds, and private keys are refused at the door and never stored. Spending
arrives with the signer in Phase 8.

## Registering a wallet

1. Export the **account-level** extended public key from a wallet you control
   (never the master key, never a private key):

   | Chain    | Account path    | Notes                                              |
   | -------- | --------------- | -------------------------------------------------- |
   | Bitcoin  | `m/84'/0'/0'`   | native SegWit (P2WPKH); `m/84'/1'/0'` on testnet   |
   | Litecoin | `m/84'/2'/0'`   | native SegWit; `m/84'/1'/0'` on testnet            |
   | Ethereum | `m/44'/60'/0'`  | also used for USDT (ERC-20)                        |
   | Tron     | `m/44'/195'/0'` | also used for USDT (TRC-20)                        |
   | XRPL     | n/a             | one classic address; invoices use destination tags |

2. `POST /v1/organizations/:orgId/wallets` with `chain`, `label` and
   `accountXpub` (or `xrplAddress`). The response includes the **first
   address** the key derives.
3. **Confirm it.** Compare that first address with the one your own wallet
   software shows for the same account, then call
   `POST …/wallets/:walletId/confirm` with it. **No address is issued until this
   matches.** It catches a wrong derivation path or the wrong account while a
   mistake still costs nothing. A mismatch is written to the audit log.

Derived addresses are `<account key>/0/<index>` (the external chain), starting
at index 0. XRPL uses one shared address with destination tags starting at 1.

## Rules enforced by the code and the database

- **Authorization.** Register, confirm and archive require the `wallet:manage`
  permission (owner or admin), a signed-in session (not an API key), and a
  session that passed **two-factor authentication**. Otherwise a stolen password
  alone could point invoices at an attacker's key. API keys with `wallet:read`
  can list wallets and addresses.
- **One key, one wallet.** A key is identified by a hash of its public key and
  chain code, not its text, so the same key re-exported as `xpub`, `zpub` or
  `tpub` is still recognised. It can belong to one wallet in the whole
  deployment, across organizations, so two merchants can never be handed the
  same address. The error message does not say who owns it.
- **Network match.** Wallets take the deployment's network. A mainnet Bitcoin or
  Litecoin key on a testnet deployment (or the reverse) is refused.
- **Enabled chains only.** A chain with no enabled asset cannot get a wallet.
- **Immutable.** Key material, chain, network and owner never change. The
  derivation counter only moves forward. A confirmation cannot be undone. A
  wallet cannot be deleted, only archived, and an archived wallet stays archived.
- **Addresses are never reused or reassigned.** Issued addresses are append-only,
  and each address (or XRPL address and tag pair) is unique across the
  deployment.
- **Concurrency.** Addresses are issued under a row lock on the wallet, so
  parallel invoices get distinct, sequential indexes. Pass the caller's
  transaction to `allocateDepositAddress` and the address commits or rolls back
  with the invoice; a failed invoice does not burn an index.

## Archiving

An archived wallet stops issuing addresses, but its addresses must **keep being
watched**: customers pay late. Phase 6 watchers watch addresses of archived
wallets too.

## Limits and decisions to review

- **Gap limit.** `ADDRESS_GAP = 20`. Phase 6 watchers must keep
  `next_index + 20` addresses imported on the node, matching `chain:watch`.
- **One XRPL account belongs to one organization.** Destination tags are
  allocated per wallet, so two organizations cannot share an account. Use a
  separate XRPL account per organization. (Sharing would need tags drawn from a
  deployment-wide counter; say if you want that.)
- **No address lookup endpoint yet.** Addresses are issued internally (by
  invoices from Phase 5) and listed read-only. There is deliberately no public
  "give me a new address" call, which would let anyone exhaust a wallet.
- **Path is not provable from the key.** An extended key does not reveal its
  derivation path, only its depth (3 is required). The confirmation step is what
  catches a wrong path.
- **Change addresses** (`/1/*`) are not used. Withdrawal change handling arrives
  with the signer in Phase 8.
