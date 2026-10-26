import { secp256k1 } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  DUST_LIMIT,
  p2wpkhScript,
  parseUtxoTx,
  planSpend,
  scriptForAddress,
  signP2wpkh,
  worstCaseVsize,
  type UtxoInput,
} from '@actualpay/signer';

const hex = (b: Uint8Array) => bytesToHex(b);

describe('destination scripts (BIP173 / BIP350 vectors)', () => {
  it('encodes each standard address type', () => {
    expect(
      hex(scriptForAddress('bitcoin', 'mainnet', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')),
    ).toBe('0014751e76e8199196d454941c45d1b3a323f1433bd6');
    expect(
      hex(scriptForAddress('bitcoin', 'mainnet', 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4')),
    ).toBe('0014751e76e8199196d454941c45d1b3a323f1433bd6');
    expect(
      hex(
        scriptForAddress(
          'bitcoin',
          'mainnet',
          'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3',
        ),
      ),
    ).toBe('00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262');
    expect(
      hex(
        scriptForAddress(
          'bitcoin',
          'mainnet',
          'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
        ),
      ),
    ).toBe('512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
    expect(hex(scriptForAddress('bitcoin', 'mainnet', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'))).toBe(
      '76a914' + '77bff20c60e522dfaa3350c39b030a5d004e839a' + '88ac',
    );
    expect(hex(scriptForAddress('bitcoin', 'mainnet', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'))).toBe(
      'a914' + 'b472a266d0bd89c13706a4132ccfb16f7c3b9fcb' + '87',
    );
  });

  it('rejects wrong networks, bad checksums, mixed case and wrong versions', () => {
    expect(() =>
      scriptForAddress('bitcoin', 'testnet', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'),
    ).toThrow();
    expect(() =>
      scriptForAddress('bitcoin', 'mainnet', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5'),
    ).toThrow();
    expect(() =>
      scriptForAddress('bitcoin', 'mainnet', 'Bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'),
    ).toThrow();
    expect(() =>
      scriptForAddress('bitcoin', 'mainnet', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'),
    ).toThrow();
    expect(() => scriptForAddress('bitcoin', 'mainnet', 'nonsense')).toThrow();
    expect(() =>
      scriptForAddress('litecoin', 'mainnet', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'),
    ).toThrow();
    // A bech32m encoding of a version-0 program is invalid.
    expect(() =>
      scriptForAddress('bitcoin', 'mainnet', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7k'),
    ).toThrow();
  });
});

describe('spending plans', () => {
  const key = Uint8Array.from(Buffer.from('11'.repeat(32), 'hex'));
  const changeScript = p2wpkhScript(secp256k1.getPublicKey(key, true));
  const destination = scriptForAddress(
    'bitcoin',
    'mainnet',
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  );
  const coin = (n: number, amount: bigint): UtxoInput => ({
    txid: n.toString(16).padStart(64, '0'),
    vout: 0,
    amount,
  });
  const plan = (utxos: UtxoInput[], amount: bigint, excluded = new Set<string>(), feeRate = 10n) =>
    planSpend({ utxos, excluded, destination, amount, changeScript, feeRate });

  it('pays the exact amount, returns change, and meets the fee rate', () => {
    const result = plan([coin(1, 1_000_000n)], 100_000n);
    expect(result.outputs[0]?.amount).toBe(100_000n);
    expect(result.changeAmount).toBe(1_000_000n - 100_000n - result.fee);
    const vsize = worstCaseVsize(1, result.outputs);
    expect(result.fee).toBe(BigInt(vsize) * 10n);
    expect(result.inputs.reduce((n, i) => n + i.amount, 0n)).toBe(
      result.outputs.reduce((n, o) => n + o.amount, 0n) + result.fee,
    ); // nothing is created or lost
  });

  it('picks the largest coins first and adds more only as needed', () => {
    const result = plan([coin(1, 50_000n), coin(2, 900_000n), coin(3, 20_000n)], 100_000n);
    expect(result.inputs.map((i) => i.amount)).toEqual([900_000n]);
    const big = plan([coin(1, 60_000n), coin(2, 60_000n), coin(3, 60_000n)], 100_000n);
    expect(big.inputs).toHaveLength(2);
  });

  it('never selects excluded outpoints', () => {
    const utxos = [coin(1, 1_000_000n), coin(2, 500_000n)];
    const result = plan(utxos, 100_000n, new Set([`${utxos[0]?.txid}:0`]));
    expect(result.inputs.map((i) => i.txid)).toEqual([utxos[1]?.txid]);
    expect(() => plan(utxos, 100_000n, new Set(utxos.map((u) => `${u.txid}:0`)))).toThrow(
      /Insufficient/,
    );
  });

  it('gives sub-dust change to the miners instead of creating an unspendable output', () => {
    const fee = BigInt(worstCaseVsize(1, [{ script: destination, amount: 0n }])) * 10n;
    const result = plan([coin(1, 100_000n + fee + 100n)], 100_000n);
    expect(result.outputs).toHaveLength(1);
    expect(result.changeAmount).toBe(0n);
    expect(result.fee).toBe(fee + 100n);
  });

  it('refuses dust payments, insufficient funds and a zero fee rate', () => {
    expect(() => plan([coin(1, 1_000_000n)], DUST_LIMIT - 1n)).toThrow(/dust/);
    expect(() => plan([coin(1, 1_000n)], 100_000n)).toThrow(/Insufficient/);
    expect(() => plan([coin(1, 1_000_000n)], 100_000n, new Set(), 0n)).toThrow(/fee rate/);
  });
});

describe('signing', () => {
  const key = Uint8Array.from(Buffer.from('22'.repeat(32), 'hex'));
  const publicKey = secp256k1.getPublicKey(key, true);
  const destination = scriptForAddress(
    'bitcoin',
    'mainnet',
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  );
  const inputs: UtxoInput[] = [
    { txid: 'aa'.repeat(32), vout: 1, amount: 700_000n },
    { txid: 'bb'.repeat(32), vout: 0, amount: 400_000n },
  ];
  const outputs = [
    { script: destination, amount: 1_000_000n },
    { script: p2wpkhScript(publicKey), amount: 99_000n },
  ];

  it('is deterministic and parses back to exactly what was signed', () => {
    const a = signP2wpkh({ inputs, outputs, privateKey: key });
    const b = signP2wpkh({ inputs, outputs, privateKey: key });
    expect(a).toEqual(b);
    const parsed = parseUtxoTx(a.raw);
    expect(parsed.txid).toBe(a.txid);
    expect(parsed.inputs).toEqual(inputs.map((i) => ({ txid: i.txid, vout: i.vout })));
    expect(parsed.outputs).toEqual(
      outputs.map((o) => ({ amount: o.amount, script: hex(o.script) })),
    );
  });

  it('has a txid that depends on every input and output', () => {
    const base = signP2wpkh({ inputs, outputs, privateKey: key }).txid;
    expect(
      signP2wpkh({ inputs: [inputs[0] as UtxoInput], outputs, privateKey: key }).txid,
    ).not.toBe(base);
    expect(
      signP2wpkh({
        inputs,
        outputs: [
          { ...(outputs[0] as (typeof outputs)[0]), amount: 999_999n },
          outputs[1] as (typeof outputs)[0],
        ],
        privateKey: key,
      }).txid,
    ).not.toBe(base);
  });

  it('never claims a smaller virtual size than the real one', () => {
    const signed = signP2wpkh({ inputs, outputs, privateKey: key });
    expect(worstCaseVsize(inputs.length, outputs)).toBeGreaterThanOrEqual(signed.vsize);
    expect(worstCaseVsize(inputs.length, outputs) - signed.vsize).toBeLessThanOrEqual(
      inputs.length,
    );
  });

  it('rejects trailing bytes and empty transactions', () => {
    const { raw } = signP2wpkh({ inputs, outputs, privateKey: key });
    expect(() => parseUtxoTx(raw + '00')).toThrow();
    expect(() => signP2wpkh({ inputs: [], outputs, privateKey: key })).toThrow();
    expect(() => signP2wpkh({ inputs, outputs: [], privateKey: key })).toThrow();
  });
});
