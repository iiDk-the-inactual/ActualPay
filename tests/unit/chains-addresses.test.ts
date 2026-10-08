/**
 * Address derivation and validation against published test vectors.
 * Vectors come from BIP84, BIP173/BIP350, EIP-55 and well-known addresses.
 */
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { describe, expect, it } from 'vitest';
import {
  deriveEvmAddress,
  deriveTronAddress,
  deriveUtxoAddress,
  parseExtendedPublicKey,
  toChecksumAddress,
  tronToHex,
  validateAddress,
  validateEvmAddress,
  validateTronAddress,
  validateUtxoAddress,
  validateXrplAddress,
} from '@actualpay/chains';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
const accountXpub = (path: string) => root.derive(path).publicExtendedKey;

describe('BIP84 (Bitcoin native SegWit)', () => {
  it('matches the BIP84 reference vectors from an account xpub', () => {
    const account = parseExtendedPublicKey(accountXpub("m/84'/0'/0'"));
    expect(deriveUtxoAddress('bitcoin', 'mainnet', account, 0)).toBe(
      'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    );
    expect(deriveUtxoAddress('bitcoin', 'mainnet', account, 1)).toBe(
      'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
    );
  });

  it('accepts the zpub encoding of the same key', () => {
    const zpub =
      'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
    expect(deriveUtxoAddress('bitcoin', 'mainnet', parseExtendedPublicKey(zpub), 0)).toBe(
      'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    );
  });

  it('uses the network prefix for Litecoin and test networks', () => {
    const account = parseExtendedPublicKey(accountXpub("m/84'/2'/0'"));
    expect(deriveUtxoAddress('litecoin', 'mainnet', account, 0)).toMatch(
      /^ltc1q[02-9ac-hj-np-z]{38}$/,
    );
    expect(deriveUtxoAddress('litecoin', 'testnet', account, 0)).toMatch(/^tltc1q/);
    expect(deriveUtxoAddress('bitcoin', 'testnet', account, 0)).toMatch(/^tb1q/);
  });
});

describe('extended key safety', () => {
  it('refuses extended private keys', () => {
    expect(() => parseExtendedPublicKey(root.derive("m/84'/0'/0'").privateExtendedKey)).toThrow(
      /PRIVATE/,
    );
  });

  it('refuses keys that are not account-level', () => {
    expect(() => parseExtendedPublicKey(root.publicExtendedKey)).toThrow(/depth 3/);
    expect(() =>
      parseExtendedPublicKey(root.derive("m/84'/0'/0'/0").publicExtendedKey),
    ).not.toThrow();
  });

  it('rejects corrupted keys', () => {
    const xpub = accountXpub("m/84'/0'/0'");
    expect(() =>
      parseExtendedPublicKey(`${xpub.slice(0, -1)}${xpub.endsWith('A') ? 'B' : 'A'}`),
    ).toThrow(/checksum/);
  });
});

describe('Ethereum and Tron', () => {
  it('derives the well-known BIP44 Ethereum address', () => {
    expect(deriveEvmAddress(parseExtendedPublicKey(accountXpub("m/44'/60'/0'")), 0)).toBe(
      '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
    );
  });

  it('implements EIP-55 checksums', () => {
    for (const a of [
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
      '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
    ]) {
      expect(toChecksumAddress(a.toLowerCase())).toBe(a);
      expect(validateEvmAddress(a.toLowerCase())).toBe(a);
    }
    expect(validateEvmAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD')).toBeNull(); // bad checksum
    expect(validateEvmAddress('0x0000000000000000000000000000000000000000')).toBeNull();
    expect(validateEvmAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeA')).toBeNull();
  });

  it('encodes Tron addresses (USDT contract vector)', () => {
    expect(tronToHex('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(
      '41a614f803b6fd780986a42c78ec9c7f77e6ded13c',
    );
    expect(validateTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(
      'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    );
    expect(validateTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u')).toBeNull();
    const tron = deriveTronAddress(parseExtendedPublicKey(accountXpub("m/44'/195'/0'")), 0);
    expect(validateTronAddress(tron)).toBe(tron);
  });
});

describe('UTXO address validation', () => {
  it('accepts valid addresses only on their own network', () => {
    expect(
      validateUtxoAddress('bitcoin', 'mainnet', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'),
    ).not.toBeNull();
    expect(
      validateUtxoAddress('bitcoin', 'testnet', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'),
    ).toBeNull();
    expect(
      validateUtxoAddress('litecoin', 'mainnet', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'),
    ).toBeNull();
    expect(
      validateUtxoAddress('bitcoin', 'mainnet', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'),
    ).not.toBeNull();
    expect(
      validateUtxoAddress('bitcoin', 'mainnet', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'),
    ).not.toBeNull();
  });

  it('enforces bech32 vs bech32m per witness version (BIP350)', () => {
    expect(
      validateUtxoAddress(
        'bitcoin',
        'mainnet',
        'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
      ),
    ).not.toBeNull();
    // A v0 program checksummed with bech32m is invalid.
    expect(
      validateUtxoAddress('bitcoin', 'mainnet', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh'),
    ).toBeNull();
  });

  it('rejects mixed case, typos and garbage', () => {
    expect(
      validateUtxoAddress('bitcoin', 'mainnet', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyU'),
    ).toBeNull();
    expect(
      validateUtxoAddress('bitcoin', 'mainnet', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyv'),
    ).toBeNull();
    expect(validateUtxoAddress('bitcoin', 'mainnet', 'not an address')).toBeNull();
  });
});

describe('XRPL', () => {
  it('accepts classic addresses only', () => {
    expect(validateXrplAddress('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh')).toBe(
      'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
    );
    expect(validateXrplAddress('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTx')).toBeNull();
    expect(
      validateAddress('xrpl', 'mainnet', 'X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ'),
    ).toBeNull();
  });
});
