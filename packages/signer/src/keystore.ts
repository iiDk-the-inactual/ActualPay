/**
 * The hot-wallet keystore.
 *
 * One BIP39 mnemonic (24 words) is generated when the keystore is created and
 * shown to the operator exactly once, for paper backup. The file on disk holds
 * it encrypted: AES-256-GCM under a key derived from a passphrase with scrypt.
 * The addresses are stored beside it in clear (they are public) but are
 * authenticated by the cipher, so swapping an address in the file is detected.
 *
 * Keys, standard derivation paths (account 0, receive chain, index 0):
 *   Bitcoin   m/84'/0'/0'/0/0   (testnet m/84'/1'/0'/0/0)   native SegWit
 *   Litecoin  m/84'/2'/0'/0/0   (testnet m/84'/1'/0'/0/0)   native SegWit
 *   Ethereum  m/44'/60'/0'/0/0                               also used for ERC-20
 *
 * This is the software-key implementation of the signer. The same checks in
 * `sign.ts` apply to any key store; an HSM or hardware wallet can replace this
 * file without changing them.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  accountIdFromPublicKey,
  encodeP2wpkh,
  hash160,
  toChecksumAddress,
} from '@actualpay/chains';
import type { ChainFamily, NetworkMode } from '@actualpay/shared';
import { bytesToHex } from './rlp';

export const KEYSTORE_CHAINS = ['bitcoin', 'litecoin', 'ethereum'] as const;
export type KeystoreChain = (typeof KEYSTORE_CHAINS)[number];

const DEFAULT_SCRYPT_N = 2 ** 17;
const MIN_SCRYPT_N = 2 ** 15;
const MIN_PASSPHRASE_LENGTH = 12;

export interface KeystoreFile {
  readonly version: 1;
  readonly network: NetworkMode;
  readonly kdf: {
    readonly name: 'scrypt';
    readonly N: number;
    readonly r: 8;
    readonly p: 1;
    readonly salt: string;
  };
  readonly cipher: { readonly name: 'aes-256-gcm'; readonly iv: string; readonly tag: string };
  readonly ciphertext: string;
  /** Public addresses by chain. */
  readonly addresses: Readonly<Record<KeystoreChain, string>>;
}

export interface HotKey {
  readonly chain: KeystoreChain;
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly address: string;
}

function coinType(chain: KeystoreChain, network: NetworkMode): number {
  if (network === 'testnet' && chain !== 'ethereum') return 1;
  return { bitcoin: 0, litecoin: 2, ethereum: 60 }[chain];
}

function pathFor(chain: KeystoreChain, network: NetworkMode): string {
  const purpose = chain === 'ethereum' ? 44 : 84;
  return `m/${purpose}'/${coinType(chain, network)}'/0'/0/0`;
}

export function addressFor(
  chain: KeystoreChain,
  network: NetworkMode,
  publicKey: Uint8Array,
): string {
  if (chain === 'ethereum') return toChecksumAddress(bytesToHex(accountIdFromPublicKey(publicKey)));
  return encodeP2wpkh(chain, network, hash160(publicKey));
}

export function deriveHotKey(seed: Uint8Array, chain: KeystoreChain, network: NetworkMode): HotKey {
  const node = HDKey.fromMasterSeed(seed).derive(pathFor(chain, network));
  if (!node.privateKey || !node.publicKey) throw new Error('Key derivation failed');
  const publicKey = secp256k1.getPublicKey(node.privateKey, true);
  return {
    chain,
    privateKey: node.privateKey,
    publicKey,
    address: addressFor(chain, network, publicKey),
  };
}

function aad(file: Pick<KeystoreFile, 'version' | 'network' | 'kdf' | 'addresses'>): Buffer {
  // Everything but the secret is authenticated, so none of it can be swapped.
  return Buffer.from(
    JSON.stringify({
      v: file.version,
      n: file.network,
      k: file.kdf,
      a: Object.fromEntries(Object.entries(file.addresses).sort()),
    }),
  );
}

function deriveKey(passphrase: string, kdf: KeystoreFile['kdf']): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), Buffer.from(kdf.salt, 'base64'), 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 512 * 1024 * 1024,
  });
}

export function createKeystore(params: {
  passphrase: string;
  network: NetworkMode;
  /** Restore from an existing mnemonic instead of generating one. */
  mnemonic?: string;
  /** Tests only: a cheaper key derivation. Never lowered below the minimum otherwise. */
  scryptN?: number;
}): { file: KeystoreFile; mnemonic: string } {
  if (params.passphrase.length < MIN_PASSPHRASE_LENGTH)
    throw new Error(`The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  const mnemonic = params.mnemonic?.trim().replace(/\s+/g, ' ') ?? generateMnemonic(wordlist, 256);
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('The mnemonic is not valid.');
  const seed = mnemonicToSeedSync(mnemonic);
  const addresses = Object.fromEntries(
    KEYSTORE_CHAINS.map((chain) => [chain, deriveHotKey(seed, chain, params.network).address]),
  ) as Record<KeystoreChain, string>;
  const kdf: KeystoreFile['kdf'] = {
    name: 'scrypt',
    N: params.scryptN ?? DEFAULT_SCRYPT_N,
    r: 8,
    p: 1,
    salt: randomBytes(16).toString('base64'),
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(params.passphrase, kdf), iv);
  cipher.setAAD(aad({ version: 1, network: params.network, kdf, addresses }));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ mnemonic }), 'utf8'),
    cipher.final(),
  ]);
  return {
    mnemonic,
    file: {
      version: 1,
      network: params.network,
      kdf,
      cipher: {
        name: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      },
      ciphertext: ciphertext.toString('base64'),
      addresses,
    },
  };
}

export class UnlockedKeystore {
  readonly #seed: Uint8Array;
  readonly network: NetworkMode;
  readonly addresses: Readonly<Record<KeystoreChain, string>>;

  constructor(seed: Uint8Array, file: KeystoreFile) {
    this.#seed = seed;
    this.network = file.network;
    this.addresses = file.addresses;
  }

  /** The hot key for a chain. The caller must not retain or log it. */
  keyFor(chain: ChainFamily): HotKey {
    if (!(KEYSTORE_CHAINS as readonly string[]).includes(chain))
      throw new Error(`The signer has no key for ${chain}`);
    const key = deriveHotKey(this.#seed, chain as KeystoreChain, this.network);
    if (key.address !== this.addresses[chain as KeystoreChain])
      throw new Error('Derived address does not match the keystore');
    return key;
  }

  /** Best-effort: overwrite the seed in memory. */
  lock(): void {
    this.#seed.fill(0);
  }
}

export function unlockKeystore(
  file: KeystoreFile,
  passphrase: string,
  options: { allowWeakKdf?: boolean } = {},
): UnlockedKeystore {
  // The file is untrusted JSON: check the discriminators at run time.
  const claimed = file as unknown as {
    version?: unknown;
    kdf?: { name?: unknown };
    cipher?: { name?: unknown };
  };
  if (
    claimed.version !== 1 ||
    claimed.kdf?.name !== 'scrypt' ||
    claimed.cipher?.name !== 'aes-256-gcm'
  )
    throw new Error('Unsupported keystore format');
  if (!options.allowWeakKdf && file.kdf.N < MIN_SCRYPT_N)
    throw new Error('The keystore uses a key derivation that is too weak to trust');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(passphrase, file.kdf),
    Buffer.from(file.cipher.iv, 'base64'),
  );
  decipher.setAAD(aad(file));
  decipher.setAuthTag(Buffer.from(file.cipher.tag, 'base64'));
  let plain: string;
  try {
    plain = Buffer.concat([
      decipher.update(Buffer.from(file.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Wrong passphrase or a modified file: indistinguishable on purpose.
    throw new Error('Could not unlock the keystore (wrong passphrase, or the file was modified).');
  }
  const { mnemonic } = JSON.parse(plain) as { mnemonic: string };
  const seed = mnemonicToSeedSync(mnemonic);
  const unlocked = new UnlockedKeystore(seed, file);
  for (const chain of KEYSTORE_CHAINS) unlocked.keyFor(chain); // addresses must match the key
  return unlocked;
}
