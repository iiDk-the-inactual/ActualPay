import { describe, expect, it } from 'vitest';
import { createKeystore, deriveHotKey, unlockKeystore } from '@actualpay/signer';
import { mnemonicToSeedSync } from '@scure/bip39';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const FAST = { scryptN: 2 ** 12 } as const;
const PASS = 'a long passphrase for the test keystore';

describe('key derivation (published vectors)', () => {
  const seed = mnemonicToSeedSync(MNEMONIC);
  it('matches the BIP84 first Bitcoin address and the well-known Ethereum address', () => {
    expect(deriveHotKey(seed, 'bitcoin', 'mainnet').address).toBe(
      'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    );
    expect(deriveHotKey(seed, 'ethereum', 'mainnet').address).toBe(
      '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
    );
  });

  it('uses the right coin type and prefix per network', () => {
    expect(deriveHotKey(seed, 'bitcoin', 'testnet').address.startsWith('tb1q')).toBe(true);
    expect(deriveHotKey(seed, 'litecoin', 'mainnet').address.startsWith('ltc1q')).toBe(true);
    expect(deriveHotKey(seed, 'litecoin', 'testnet').address.startsWith('tltc1q')).toBe(true);
    // Litecoin and Bitcoin use different coin types on mainnet, so different keys.
    expect(deriveHotKey(seed, 'litecoin', 'mainnet').publicKey).not.toEqual(
      deriveHotKey(seed, 'bitcoin', 'mainnet').publicKey,
    );
    // Ethereum addresses do not depend on the network.
    expect(deriveHotKey(seed, 'ethereum', 'testnet').address).toBe(
      deriveHotKey(seed, 'ethereum', 'mainnet').address,
    );
  });
});

describe('keystore file', () => {
  it('round-trips, never stores the mnemonic in clear, and yields the same addresses', () => {
    const { file, mnemonic } = createKeystore({ passphrase: PASS, network: 'testnet', ...FAST });
    expect(mnemonic.split(' ')).toHaveLength(24);
    const text = JSON.stringify(file);
    expect(text).not.toContain(mnemonic.split(' ').slice(0, 2).join(' '));
    expect(text).not.toContain('mnemonic');
    const unlocked = unlockKeystore(file, PASS, { allowWeakKdf: true });
    for (const chain of ['bitcoin', 'litecoin', 'ethereum'] as const)
      expect(unlocked.keyFor(chain).address).toBe(file.addresses[chain]);
    unlocked.lock();
  });

  it('restores the same addresses from the mnemonic', () => {
    const first = createKeystore({ passphrase: PASS, network: 'testnet', ...FAST });
    const restored = createKeystore({
      passphrase: 'a different passphrase entirely',
      network: 'testnet',
      mnemonic: first.mnemonic,
      ...FAST,
    });
    expect(restored.file.addresses).toEqual(first.file.addresses);
    expect(restored.file.ciphertext).not.toBe(first.file.ciphertext);
  });

  it('fails identically for a wrong passphrase and for a modified file', () => {
    const { file } = createKeystore({ passphrase: PASS, network: 'testnet', ...FAST });
    expect(() =>
      unlockKeystore(file, 'not the right passphrase!!', { allowWeakKdf: true }),
    ).toThrow(/Could not unlock/);
    const swapped = { ...file, addresses: { ...file.addresses, bitcoin: file.addresses.litecoin } };
    expect(() => unlockKeystore(swapped, PASS, { allowWeakKdf: true })).toThrow(/Could not unlock/);
    const flipped = {
      ...file,
      ciphertext: Buffer.from(
        Buffer.from(file.ciphertext, 'base64').map((b, i) => (i === 3 ? b ^ 1 : b)),
      ).toString('base64'),
    };
    expect(() => unlockKeystore(flipped, PASS, { allowWeakKdf: true })).toThrow(/Could not unlock/);
    const otherNetwork = { ...file, network: 'mainnet' as const };
    expect(() => unlockKeystore(otherNetwork, PASS, { allowWeakKdf: true })).toThrow(
      /Could not unlock/,
    );
  });

  it('rejects weak passphrases, bad mnemonics and a weakened key derivation', () => {
    expect(() => createKeystore({ passphrase: 'short', network: 'testnet', ...FAST })).toThrow(
      /at least 12/,
    );
    expect(() =>
      createKeystore({ passphrase: PASS, network: 'testnet', mnemonic: 'not a mnemonic', ...FAST }),
    ).toThrow(/not valid/);
    const { file } = createKeystore({ passphrase: PASS, network: 'testnet', ...FAST });
    expect(() => unlockKeystore(file, PASS)).toThrow(/too weak/); // the test file uses N=2^12
  });
});
