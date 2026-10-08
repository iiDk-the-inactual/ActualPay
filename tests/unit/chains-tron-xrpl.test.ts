/**
 * TRON and XRPL adapters against fixtures shaped like the documented API
 * responses. The TRON adapter runs over real HTTP against a local fixture
 * server; the XRPL adapter uses a fixture requester. Live-network checks
 * are in TASKS.md (Nile testnet, XRPL testnet).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  normalizeTronAddress,
  TronAdapter,
  tronToHex,
  XrplAdapter,
  type XrplRequester,
} from '@actualpay/chains';

const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const DEPOSIT = 'TJmmqjb1DK9TTZbQXzRQ2AuA94z4gKAPFh';
const DEPOSIT_HEX = tronToHex(DEPOSIT); // 41-prefixed
const OTHER = 'TLCuBEirVzB6V4menLZKw1jfBTFMZbuKq7';
const FAKE_TOKEN = 'TEEXEWrkMFKapSMJ6mErg39ELFKDqEs6w3';
const tx = (n: number) => n.toString(16).padStart(64, 'a');

// Raw JSON text so large integers stay exact on the wire, as a real node sends them.
const routes: Record<string, string> = {
  'POST /wallet/getnowblock': `{"block_header":{"raw_data":{"number":70000100,"timestamp":${String(Date.now())}}}}`,
  'POST /walletsolidity/getnowblock': '{"block_header":{"raw_data":{"number":70000081}}}',
  [`GET /v1/accounts/${DEPOSIT}/transactions`]: JSON.stringify({
    success: true,
    meta: {},
    data: [
      {
        txID: tx(1),
        blockNumber: 70000001,
        block_timestamp: 1,
        ret: [{ contractRet: 'SUCCESS' }],
        raw_data: {
          contract: [
            {
              type: 'TransferContract',
              parameter: {
                value: {
                  amount: 123456789,
                  owner_address: '41' + 'b'.repeat(40),
                  to_address: DEPOSIT_HEX,
                },
              },
            },
          ],
        },
      },
      {
        txID: tx(2),
        blockNumber: 70000002,
        block_timestamp: 2,
        ret: [{ contractRet: 'REVERT' }],
        raw_data: {
          contract: [
            {
              type: 'TransferContract',
              parameter: { value: { amount: 5, to_address: DEPOSIT_HEX } },
            },
          ],
        },
      },
      {
        txID: tx(3),
        blockNumber: 70000003,
        block_timestamp: 3,
        ret: [{ contractRet: 'SUCCESS' }],
        raw_data: {
          contract: [
            {
              type: 'TriggerSmartContract',
              parameter: { value: { contract_address: tronToHex(USDT) } },
            },
          ],
        },
      },
    ],
  }),
  [`GET /v1/accounts/${DEPOSIT}/transactions/trc20`]: JSON.stringify({
    success: true,
    meta: {},
    data: [
      {
        transaction_id: tx(10),
        block_timestamp: 10,
        from: OTHER,
        to: DEPOSIT,
        value: '25000000',
        type: 'Transfer',
        token_info: { address: USDT, decimals: 6 },
      },
      {
        transaction_id: tx(11),
        block_timestamp: 11,
        from: OTHER,
        to: DEPOSIT,
        value: '7',
        type: 'Transfer',
        token_info: { address: USDT, decimals: 6 },
      },
    ],
  }),
  [`GET /v1/transactions/${tx(10)}/events`]: JSON.stringify({
    success: true,
    meta: {},
    data: [
      {
        event_name: 'Transfer',
        event_index: 0,
        block_number: 70000010,
        contract_address: USDT,
        result: { from: '0x' + 'b'.repeat(40), to: '0x' + DEPOSIT_HEX.slice(2), value: '25000000' },
      },
    ],
  }),
  // One transaction paying the deposit twice, plus a look-alike token event in the same tx.
  [`GET /v1/transactions/${tx(11)}/events`]: JSON.stringify({
    success: true,
    meta: {},
    data: [
      {
        event_name: 'Transfer',
        event_index: 0,
        block_number: 70000011,
        contract_address: USDT,
        result: { to: '0x' + DEPOSIT_HEX.slice(2), value: '3' },
      },
      {
        event_name: 'Transfer',
        event_index: 1,
        block_number: 70000011,
        contract_address: USDT,
        result: { to: '0x' + DEPOSIT_HEX.slice(2), value: '4' },
      },
      {
        event_name: 'Transfer',
        event_index: 2,
        block_number: 70000011,
        contract_address: FAKE_TOKEN,
        result: { to: '0x' + DEPOSIT_HEX.slice(2), value: '999999' },
      },
      {
        event_name: 'Approval',
        event_index: 3,
        block_number: 70000011,
        contract_address: USDT,
        result: { to: '0x' + DEPOSIT_HEX.slice(2), value: '1' },
      },
    ],
  }),
};

let server: Server;
let base: string;
const seenQueries: URLSearchParams[] = [];
const seenHeaders: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seenQueries.push(url.searchParams);
    seenHeaders.push(String(req.headers['tron-pro-api-key'] ?? ''));
    const body = routes[`${req.method} ${url.pathname}`];
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(body ?? '{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(
  () =>
    new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    ),
);

describe('TRON adapter', () => {
  const make = () =>
    new TronAdapter({
      network: 'mainnet',
      url: base,
      apiKey: 'k-123',
      token: { assetId: 'usdt-trc20', contract: USDT },
      watchedAddresses: () => Promise.resolve(new Set([DEPOSIT])),
    });

  it('normalises every TRON address encoding', () => {
    expect(normalizeTronAddress(USDT)).toBe(USDT);
    expect(normalizeTronAddress(tronToHex(USDT))).toBe(USDT);
    expect(normalizeTronAddress('0x' + tronToHex(USDT).slice(2))).toBe(USDT);
    expect(normalizeTronAddress('garbage')).toBeNull();
  });

  it('reports heights with solidified blocks as final', async () => {
    expect(await make().status()).toMatchObject({
      tipHeight: 70000100n,
      finalHeight: 70000081n,
      synced: true,
    });
  });

  it('detects successful TRX transfers and per-event USDT transfers, ignoring everything else', async () => {
    const { transfers, cursor } = await make().scanIncoming(JSON.stringify({ v: 1, since: 0 }));
    const byRef = Object.fromEntries(transfers.map((t) => [t.ref, t]));
    expect(Object.keys(byRef).sort()).toEqual(
      [`trx:${tx(1)}:native`, `trx:${tx(10)}:0`, `trx:${tx(11)}:0`, `trx:${tx(11)}:1`].sort(),
    );
    expect(byRef[`trx:${tx(1)}:native`]).toMatchObject({
      assetId: 'trx',
      amount: 123456789n,
      toAddress: DEPOSIT,
      final: true,
      confirmations: 100n,
    });
    expect(byRef[`trx:${tx(10)}:0`]).toMatchObject({ assetId: 'usdt-trc20', amount: 25_000_000n });
    expect(byRef[`trx:${tx(11)}:1`]!.amount).toBe(4n);
    expect(JSON.parse(cursor)).toEqual({ v: 1, since: 11 });
  });

  it('only asks for solidified, incoming data and sends the API key', async () => {
    seenQueries.length = 0;
    await make().scanIncoming(JSON.stringify({ v: 1, since: 120_000 }));
    const listQueries = seenQueries.filter((q) => q.has('only_to'));
    expect(listQueries.length).toBeGreaterThan(0);
    for (const q of listQueries) {
      expect(q.get('only_confirmed')).toBe('true');
      expect(q.get('only_to')).toBe('true');
      expect(q.get('min_timestamp')).toBe('60000'); // since minus the 60 s overlap
    }
    expect(seenHeaders.every((h) => h === 'k-123')).toBe(true);
  });

  it('rejects bad cursors and refs', async () => {
    await expect(make().scanIncoming('{"v":2}')).rejects.toThrow(/cursor/);
    await expect(make().recheck('eth:0x1:native')).rejects.toThrow();
  });
});

describe('XRPL adapter', () => {
  const ACCOUNT = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
  const H = (n: number) => n.toString(16).toUpperCase().padStart(64, 'F');
  const payment = (
    n: number,
    overrides: {
      tx?: Record<string, unknown>;
      meta?: Record<string, unknown>;
      validated?: boolean;
    },
  ) => ({
    hash: H(n),
    ledger_index: 1000 + n,
    validated: overrides.validated ?? true,
    tx_json: {
      TransactionType: 'Payment',
      Account: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
      Destination: ACCOUNT,
      DeliverMax: '1000000',
      DestinationTag: n,
      ...overrides.tx,
    },
    meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '1000000', ...overrides.meta },
  });

  const pages: Record<string, unknown>[] = [
    {
      ledger_index_max: 1100,
      marker: { ledger: 1050, seq: 1 },
      transactions: [
        payment(1, {}),
        // Partial payment: claims 1,000 XRP but delivers 1 drop. Must credit 1 drop.
        payment(2, {
          tx: { Amount: '1000000000', DeliverMax: '1000000000', Flags: 0x00020000 },
          meta: { delivered_amount: '1' },
        }),
        payment(3, { meta: { TransactionResult: 'tecPATH_DRY' } }),
        payment(4, {
          meta: {
            delivered_amount: {
              currency: 'USD',
              issuer: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
              value: '5',
            },
          },
        }),
      ],
    },
    {
      ledger_index_max: 1100,
      transactions: [
        payment(5, { tx: { DestinationTag: undefined } }),
        payment(6, { tx: { Destination: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe' } }), // outgoing
        payment(7, { validated: false }),
        {
          hash: H(8),
          ledger_index: 1008,
          validated: true,
          tx_json: { TransactionType: 'TrustSet', Account: ACCOUNT },
          meta: { TransactionResult: 'tesSUCCESS' },
        },
      ],
    },
  ];

  const commands: Record<string, unknown>[] = [];
  const requester: XrplRequester = {
    request(command) {
      commands.push(command);
      if (command['command'] === 'server_state') {
        return Promise.resolve({
          state: {
            server_state: 'full',
            validated_ledger: { seq: 1100, reserve_base: 1000000, reserve_inc: 200000 },
          },
        });
      }
      if (command['command'] === 'account_tx')
        return Promise.resolve(command['marker'] ? pages[1]! : pages[0]!);
      if (command['command'] === 'account_info')
        return Promise.resolve({ account_data: { Flags: 0x00020000 } });
      return Promise.reject(new Error('unexpected command'));
    },
  };
  const adapter = new XrplAdapter({ network: 'testnet', requester, depositAccount: ACCOUNT });

  it('credits delivered_amount (never Amount) and only successful, validated XRP payments to us', async () => {
    const { transfers, cursor } = await adapter.scanIncoming('999');
    expect(transfers.map((t) => [t.ref, t.amount, t.destinationTag])).toEqual([
      [`xrp:${H(1)}`, 1_000_000n, 1],
      [`xrp:${H(2)}`, 1n, 2],
      [`xrp:${H(5)}`, 1_000_000n, undefined],
    ]);
    expect(transfers.every((t) => t.final)).toBe(true);
    expect(cursor).toBe('1100');
    const accountTx = commands.filter((c) => c['command'] === 'account_tx');
    expect(accountTx[0]).toMatchObject({
      ledger_index_min: 1000,
      ledger_index_max: -1,
      forward: true,
    });
    expect(accountTx[1]!['marker']).toEqual({ ledger: 1050, seq: 1 });
  });

  it('reads reserves and the RequireDest flag live', async () => {
    expect(await adapter.reserves()).toEqual({ base: 1_000_000n, perObject: 200_000n });
    expect(await adapter.requiresDestinationTag()).toBe(true);
    expect(await adapter.status()).toMatchObject({
      tipHeight: 1100n,
      finalHeight: 1100n,
      synced: true,
    });
  });

  it('refuses unavailable delivered amounts rather than guessing', async () => {
    const strict = new XrplAdapter({
      network: 'testnet',
      depositAccount: ACCOUNT,
      requester: {
        request: () =>
          Promise.resolve({
            ledger_index_max: 1,
            transactions: [payment(9, { meta: { delivered_amount: 'unavailable' } })],
          }),
      },
    });
    await expect(strict.scanIncoming('0')).rejects.toThrow(/unavailable/);
  });

  it('rejects invalid accounts, cursors and refs', async () => {
    expect(
      () => new XrplAdapter({ network: 'testnet', requester, depositAccount: 'rNotAnAddress' }),
    ).toThrow();
    await expect(adapter.scanIncoming('abc')).rejects.toThrow(/cursor/);
    await expect(adapter.recheck('xrp:lowercase')).rejects.toThrow();
  });
});
