/**
 * Watch-only address derivation from extended public keys.
 *
 * The operator exports an *account-level* extended public key from a wallet
 * they control (e.g. m/84'/0'/0' for Bitcoin, m/44'/60'/0' for Ethereum).
 * ActualPay derives receive addresses at `<account>/0/<index>` (BIP44 external
 * chain). Extended *private* keys are refused: this code path must never be
 * able to spend.
 */
import { HDKey } from '@scure/bip32';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { encodeP2wpkh, encodeTronAddress, toChecksumAddress, type UtxoNetwork } from './addresses';

const base58check = createBase58check(sha256);

/** Public version bytes (SLIP-132) we accept, by name. Private versions are listed only to reject them. */
const PUBLIC_VERSIONS: Readonly<Record<string, number>> = {
  xpub: 0x0488b21e,
  ypub: 0x049d7cb2,
  zpub: 0x04b24746,
  tpub: 0x043587cf,
  upub: 0x044a5262,
  vpub: 0x045f1cf6,
  Ltub: 0x019da462,
  Mtub: 0x01b26ef6,
};
const PRIVATE_VERSIONS = new Set([
  0x0488ade4, 0x049d7878, 0x04b2430c, 0x04358394, 0x044a4e28, 0x045f18bc, 0x019d9cfe, 0x01b26792,
]);

export const MAX_DERIVATION_INDEX = 2 ** 31 - 1;

export function parseExtendedPublicKey(extendedKey: string): HDKey {
  let payload: Uint8Array;
  try {
    payload = base58check.decode(extendedKey.trim());
  } catch {
    throw new Error('Invalid extended public key (bad base58 checksum).');
  }
  if (payload.length !== 78) throw new Error('Invalid extended public key length.');
  const version = new DataView(payload.buffer, payload.byteOffset).getUint32(0);
  if (PRIVATE_VERSIONS.has(version) || payload[45] === 0) {
    throw new Error(
      'An extended PRIVATE key was supplied. Only extended public keys are accepted here.',
    );
  }
  if (!Object.values(PUBLIC_VERSIONS).includes(version))
    throw new Error('Unsupported extended public key version.');
  const key = HDKey.fromExtendedKey(extendedKey.trim(), { public: version, private: 0 });
  if (key.privateKey) throw new Error('Extended private keys are not accepted.');
  if (key.depth < 3) {
    // Account-level keys are depth 3. Accepting a master or purpose-level key
    // would silently derive addresses on an unexpected path.
    throw new Error(
      `Expected an account-level extended public key (depth 3), got depth ${key.depth}.`,
    );
  }
  return key;
}

function deriveReceivePublicKey(account: HDKey, index: number): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index > MAX_DERIVATION_INDEX)
    throw new RangeError('Invalid derivation index');
  const child = account.deriveChild(0).deriveChild(index);
  if (!child.publicKey) throw new Error('Derivation produced no public key');
  return child.publicKey;
}

export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/** P2WPKH receive address for BTC/LTC at <account>/0/<index>. */
export function deriveUtxoAddress(
  chain: 'bitcoin' | 'litecoin',
  network: UtxoNetwork,
  account: HDKey,
  index: number,
): string {
  return encodeP2wpkh(chain, network, hash160(deriveReceivePublicKey(account, index)));
}

/** 20-byte account id shared by Ethereum and Tron: last 20 bytes of keccak256(uncompressed pubkey without prefix). */
export function accountIdFromPublicKey(compressed: Uint8Array): Uint8Array {
  const uncompressed = secp256k1.Point.fromBytes(compressed).toBytes(false);
  return keccak_256(uncompressed.subarray(1)).subarray(12);
}

/** EIP-55 checksummed Ethereum address at <account>/0/<index> (account = m/44'/60'/0'). */
export function deriveEvmAddress(account: HDKey, index: number): string {
  return toChecksumAddress(
    Buffer.from(accountIdFromPublicKey(deriveReceivePublicKey(account, index))).toString('hex'),
  );
}

/** Tron base58 address at <account>/0/<index> (account = m/44'/195'/0'). */
export function deriveTronAddress(account: HDKey, index: number): string {
  return encodeTronAddress(accountIdFromPublicKey(deriveReceivePublicKey(account, index)));
}
