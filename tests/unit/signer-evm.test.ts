import { secp256k1 } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'vitest';
import { accountIdFromPublicKey, toChecksumAddress } from '@actualpay/chains';
import {
  bytesToHex,
  erc20TransferData,
  hexToBytes,
  recoverSender,
  rlp,
  signEip1559,
} from '@actualpay/signer';

const hex = (b: Uint8Array) => bytesToHex(b);

describe('RLP encoding (published vectors)', () => {
  it('encodes the canonical examples', () => {
    expect(hex(rlp(''))).toBe('80');
    expect(hex(rlp('dog'))).toBe('83646f67');
    expect(hex(rlp(['cat', 'dog']))).toBe('c88363617483646f67');
    expect(hex(rlp([]))).toBe('c0');
    expect(hex(rlp(0))).toBe('80');
    expect(hex(rlp(15))).toBe('0f');
    expect(hex(rlp(1024))).toBe('820400');
    expect(hex(rlp([[], [[]], [[], [[]]]]))).toBe('c7c0c1c0c3c0c1c0');
    expect(hex(rlp(Uint8Array.of(0x7f)))).toBe('7f');
    expect(hex(rlp(Uint8Array.of(0x80)))).toBe('8180');
  });

  it('encodes a long string with a length prefix', () => {
    const text = 'Lorem ipsum dolor sit amet, consectetur adipisicing elit';
    expect(hex(rlp(text))).toBe(`b838${Buffer.from(text).toString('hex')}`);
  });

  it('refuses negative numbers', () => {
    expect(() => rlp(-1n)).toThrow();
  });
});

describe('EIP-1559 signing', () => {
  const privateKey = Uint8Array.from(Buffer.from('46'.repeat(32), 'hex'));
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  const from = toChecksumAddress(hex(accountIdFromPublicKey(publicKey)));
  const tx = {
    chainId: 31337n,
    nonce: 7n,
    maxPriorityFeePerGas: 1_000_000_000n,
    maxFeePerGas: 30_000_000_000n,
    gasLimit: 21_000n,
    to: '0x' + 'ab'.repeat(20),
    value: 123_456_789_000_000_000n,
    data: '0x',
  } as const;

  it('produces a transaction attributed to the signing key, deterministically', () => {
    const a = signEip1559(tx, privateKey);
    const b = signEip1559(tx, privateKey);
    expect(a).toEqual(b);
    expect(a.raw.startsWith('0x02')).toBe(true);
    expect(recoverSender(a.raw)).toBe(from);
    expect(a.txid).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('changes the hash and sender attribution when anything is changed', () => {
    const base = signEip1559(tx, privateKey);
    expect(signEip1559({ ...tx, nonce: 8n }, privateKey).txid).not.toBe(base.txid);
    expect(signEip1559({ ...tx, value: tx.value + 1n }, privateKey).txid).not.toBe(base.txid);
    const otherKey = Uint8Array.from(Buffer.from('47'.repeat(32), 'hex'));
    expect(recoverSender(signEip1559(tx, otherKey).raw)).not.toBe(from);
  });

  it('refuses a priority fee above the max fee and malformed recipients', () => {
    expect(() =>
      signEip1559({ ...tx, maxPriorityFeePerGas: tx.maxFeePerGas + 1n }, privateKey),
    ).toThrow();
    expect(() => signEip1559({ ...tx, to: '0x1234' }, privateKey)).toThrow();
  });

  it('rejects trailing bytes and wrong transaction types when recovering', () => {
    const { raw } = signEip1559(tx, privateKey);
    expect(() => recoverSender(raw + '00')).toThrow();
    expect(() => recoverSender('0x01' + raw.slice(4))).toThrow();
  });
});

describe('ERC-20 transfer data', () => {
  it('matches the ABI encoding', () => {
    const data = erc20TransferData('0x' + '11'.repeat(20), 1_000_000n);
    expect(data).toBe(
      '0xa9059cbb' +
        '000000000000000000000000' +
        '11'.repeat(20) +
        '00000000000000000000000000000000000000000000000000000000000f4240',
    );
    expect(hexToBytes(data)).toHaveLength(4 + 32 + 32);
  });

  it('refuses out-of-range amounts and bad recipients', () => {
    expect(() => erc20TransferData('0x' + '11'.repeat(20), -1n)).toThrow();
    expect(() => erc20TransferData('0x' + '11'.repeat(20), 2n ** 256n)).toThrow();
    expect(() => erc20TransferData('0x11', 1n)).toThrow();
  });
});
