# Chain Integration (Phase 3)

ActualPay talks to blockchains only through **watch-only adapters**
(`packages/chains`). They read the chain, derive receive addresses from
extended _public_ keys, and report incoming transfers. They cannot sign or
send anything; that is the signer's job (Phase 8).

Run `npm run chain:probe` to check every enabled backend.

## Contract every adapter fulfils

- `status()`: tip height, highest _final_ height, and whether the backend is synced.
- `scanIncoming(cursor)`: incoming transfers since the cursor. Each transfer
  is reported **at least once**. Callers track non-final transfers and call
  `recheck()` until each becomes final or disappears.
- `recheck(ref)`: re-verifies a transfer. It returns `missing` if the transfer
  was reorged out, double-spent, or failed.
- Every transfer carries a stable `ref` (the ledger idempotency key), an
  exact `bigint` amount, and `final`. **Only final transfers may be credited.**
  Phase 6 additionally refuses to credit while `status().synced` is false.

## Per chain

| Asset(s)           | Backend                                                   | Receiving model                                               | Final when                                   |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| BTC                | Your own Bitcoin Core **v30+**                            | Watch-only _descriptor_ wallet, `wpkh(xpub/0/*)`              | `BITCOIN_CONFIRMATIONS` (default 2)          |
| LTC                | Your own Litecoin Core **0.21.x**                         | Watch-only _legacy_ wallet, same descriptor via `importmulti` | `LITECOIN_CONFIRMATIONS` (default 6)         |
| ETH, USDT (ERC-20) | Any Ethereum JSON-RPC (own node or provider)              | Per-invoice HD addresses; block scan + `eth_getLogs`          | Block ≤ node's `finalized` block             |
| TRX, USDT (TRC-20) | TronGrid-compatible API (TronGrid, provider, or own node) | Per-invoice HD addresses; account history                     | Solidified data only (`only_confirmed=true`) |
| XRP                | Any rippled/Clio WebSocket                                | One account + destination tag per invoice                     | Validated ledger                             |

### Bitcoin and Litecoin

- **Why your own node:** the node's wallet indexes payments to our
  descriptor, so no third-party indexer is trusted with which addresses are
  ours.
- **Why two wallet modes:** Bitcoin Core removed legacy wallets in v30, so
  descriptors are mandatory there. The official Litecoin Core 0.21.4
  binaries are built without descriptor-wallet support (`createwallet`
  fails with "Descriptor wallets not supported"), so Litecoin uses a legacy
  watch-only wallet. Both are created with private keys disabled, and the
  adapter refuses any wallet that has them enabled.
- **Import safety:** before importing, the adapter asks the node to derive
  the first five addresses and compares them with its own derivation. Any
  mismatch (wrong key, network or path) aborts the import.
- **Exact amounts:** node RPCs send amounts as JSON decimals. They are
  parsed from their exact source text (`JSON.parse` source access, Node
  22+), never through floating point.
- **Pruning:** a pruned node works for new descriptors (imported with
  `timestamp: now`), but cannot rescan history. Do not prune if you may need
  to re-import an old account.

### Ethereum

- The endpoint's chain id is checked against `ETHEREUM_CHAIN_ID` before use.
- Only the configured token contract's `Transfer` events count. Look-alike
  tokens with the same symbol are ignored, and so are failed transactions.
- Each scan re-reads a 12-block overlap below the cursor so that a block
  replaced near the tip is rescanned.
- **Limitation:** ETH sent _by a contract_ (internal transfers, used by
  some smart-contract wallets and exchanges) is not a top-level transaction
  and is not detected. Phase 6 balance reconciliation flags such deposits
  for manual review. Detecting them automatically requires trace APIs
  (`debug_traceBlock` / `trace_block`), which many providers do not offer.
- **Sweeping cost:** token deposit addresses hold no ETH. Moving USDT out
  requires funding gas first (Phase 8).

### TRON

- Uses `/v1/accounts/{address}/transactions` and `/transactions/trc20` with
  `only_confirmed=true&only_to=true`. It then reads each transaction's
  events to get the `event_index`, so two transfers in one transaction get
  distinct refs.
- TRX transfers must be `TransferContract` with result `SUCCESS`.
- **Limitation:** TRX sent by a contract (internal transactions) is not
  detected (same mitigation as Ethereum).
- Production use of TronGrid requires an API key (`TRON_API_KEY`).

### XRP Ledger

- **Partial-payment protection:** the credited amount is always
  `meta.delivered_amount`, never `Amount`.
- Payments that delivered a non-XRP currency are ignored. An
  `"unavailable"` delivered amount stops the scan rather than guessing.
- The deposit account should have **RequireDest** set, so the ledger
  rejects untagged payments. `chain:probe` reports whether it is set.
- Reserves are read live (`server_state`), because they change by validator vote.

## Address derivation

Receive addresses are `<account xpub>/0/<index>`, with the account key
exported from a wallet you control:

| Chain    | Account path                          | Address type                           |
| -------- | ------------------------------------- | -------------------------------------- |
| Bitcoin  | `m/84'/0'/0'` (testnet `m/84'/1'/0'`) | P2WPKH (`bc1q…` / `tb1q…`)             |
| Litecoin | `m/84'/2'/0'` (testnet `m/84'/1'/0'`) | P2WPKH (`ltc1q…` / `tltc1q…`)          |
| Ethereum | `m/44'/60'/0'`                        | EIP-55 checksummed                     |
| TRON     | `m/44'/195'/0'`                       | Base58 `T…`                            |
| XRPL     | n/a                                   | One classic address + destination tags |

Extended _private_ keys and keys at the wrong depth are rejected.
Derivation is tested against BIP84, EIP-55 and other published vectors,
and against the node's own `deriveaddresses` on regtest.

## What was tested where

| Adapter                      | Tested against                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Bitcoin Core / Litecoin Core | Real Litecoin Core 0.21.4 in regtest (CI and locally). Bitcoin Core v30 must be verified on your machine (TASKS.md). |
| Ethereum                     | Real Anvil node: deploys a test ERC-20, sends ETH and tokens, simulates a reorg                                      |
| TRON                         | Fixture server shaped on TronGrid documentation; **live check on Nile testnet is in TASKS.md**                       |
| XRPL                         | Fixture responses shaped on the rippled API; **live check on XRPL testnet is in TASKS.md**                           |
