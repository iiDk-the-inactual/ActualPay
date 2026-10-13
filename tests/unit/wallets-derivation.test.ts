import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { describe, expect, it } from 'vitest';
import { extendedKeyId, extendedKeyNetwork, parseExtendedPublicKey } from '@actualpay/chains';
import { deriveDeposit } from '@actualpay/wallets';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
const account = (path: string) => root.derive(path).publicExtendedKey;

describe('wallet deposit derivation (published vectors)', () => {
  it('matches the BIP84 mainnet vectors', () => {
    const wallet = {
      chain: 'bitcoin',
      network: 'mainnet',
      account_xpub: account("m/84'/0'/0'"),
      xrpl_address: null,
    } as const;
    expect(deriveDeposit(wallet, 0).address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    expect(deriveDeposit(wallet, 1).address).toBe('bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g');
  });

  it('matches the well-known Ethereum address for this mnemonic', () => {
    const wallet = {
      chain: 'ethereum',
      network: 'mainnet',
      account_xpub: account("m/44'/60'/0'"),
      xrpl_address: null,
    } as const;
    expect(deriveDeposit(wallet, 0).address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  });

  it('uses the index as the destination tag for XRPL and rejects tag 0', () => {
    const wallet = {
      chain: 'xrpl',
      network: 'testnet',
      account_xpub: null,
      xrpl_address: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
    } as const;
    expect(deriveDeposit(wallet, 7)).toEqual({
      address: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
      destinationTag: 7,
    });
    expect(() => deriveDeposit(wallet, 0)).toThrow(RangeError);
    expect(() => deriveDeposit(wallet, 2 ** 32)).toThrow(RangeError);
  });

  it('rejects out-of-range derivation indexes', () => {
    const wallet = {
      chain: 'ethereum',
      network: 'mainnet',
      account_xpub: account("m/44'/60'/0'"),
      xrpl_address: null,
    } as const;
    expect(() => deriveDeposit(wallet, -1)).toThrow(RangeError);
    expect(() => deriveDeposit(wallet, 2 ** 31)).toThrow(RangeError);
    expect(() => deriveDeposit(wallet, 1.5)).toThrow(RangeError);
  });
});

describe('extended key identity', () => {
  it('is the same for one key in different serializations, and different for other keys', () => {
    const asXpub = parseExtendedPublicKey(account("m/84'/0'/0'"));
    const asTpub = parseExtendedPublicKey(
      HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC), {
        private: 0x04358394,
        public: 0x043587cf,
      }).derive("m/84'/0'/0'").publicExtendedKey,
    );
    expect(extendedKeyId(asXpub)).toBe(extendedKeyId(asTpub));
    expect(extendedKeyNetwork(asXpub)).toBe('mainnet');
    expect(extendedKeyNetwork(asTpub)).toBe('testnet');
    expect(extendedKeyId(parseExtendedPublicKey(account("m/84'/0'/1'")))).not.toBe(
      extendedKeyId(asXpub),
    );
  });
});
