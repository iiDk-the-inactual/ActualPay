/**
 * Address encoding and validation, per chain and network.
 *
 * Validation is strict and network-aware: a testnet address is rejected on
 * mainnet and vice versa, because sending to it would lose funds. Every
 * validator returns the canonical form (or null), and callers store and
 * compare only canonical forms.
 */
import { bech32, bech32m, createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { isValidClassicAddress } from 'xrpl';
import type { ChainFamily, NetworkMode } from '@actualpay/shared';

const base58check = createBase58check(sha256);

/** UTXO network parameters. `regtest` exists for local integration testing only. */
export type UtxoNetwork = NetworkMode | 'regtest';

interface UtxoParams {
  readonly hrp: string;
  readonly p2pkh: readonly number[];
  readonly p2sh: readonly number[];
}

export const UTXO_PARAMS: Readonly<
  Record<'bitcoin' | 'litecoin', Readonly<Record<UtxoNetwork, UtxoParams>>>
> = {
  bitcoin: {
    mainnet: { hrp: 'bc', p2pkh: [0x00], p2sh: [0x05] },
    testnet: { hrp: 'tb', p2pkh: [0x6f], p2sh: [0xc4] }, // testnet4 and signet share these
    regtest: { hrp: 'bcrt', p2pkh: [0x6f], p2sh: [0xc4] },
  },
  litecoin: {
    // 0x05 is Litecoin's deprecated P2SH prefix ("3..."), still valid on chain.
    mainnet: { hrp: 'ltc', p2pkh: [0x30], p2sh: [0x32, 0x05] },
    testnet: { hrp: 'tltc', p2pkh: [0x6f], p2sh: [0x3a, 0xc4] },
    regtest: { hrp: 'rltc', p2pkh: [0x6f], p2sh: [0x3a, 0xc4] },
  },
};

/** Native SegWit v0 key-hash address (P2WPKH) for a 20-byte HASH160. */
export function encodeP2wpkh(
  chain: 'bitcoin' | 'litecoin',
  network: UtxoNetwork,
  hash160: Uint8Array,
): string {
  if (hash160.length !== 20) throw new Error('P2WPKH requires a 20-byte hash');
  return bech32.encode(UTXO_PARAMS[chain][network].hrp, [0, ...bech32.toWords(hash160)]);
}

function validateSegwit(address: string, hrp: string): string | null {
  const lower = address.toLowerCase();
  // Mixed case is invalid in bech32 (BIP173).
  if (address !== lower && address !== address.toUpperCase()) return null;
  if (!lower.startsWith(`${hrp}1`)) return null;
  for (const codec of [bech32, bech32m]) {
    try {
      const decoded = codec.decode(lower as `${string}1${string}`, 90);
      if (decoded.prefix !== hrp || decoded.words.length === 0) continue;
      const version = decoded.words[0];
      if (version === undefined) continue;
      const program = codec.fromWords(decoded.words.slice(1));
      // BIP350: v0 must use bech32, v1+ must use bech32m.
      if ((version === 0) !== (codec === bech32)) continue;
      if (version > 16 || program.length < 2 || program.length > 40) continue;
      if (version === 0 && program.length !== 20 && program.length !== 32) continue;
      if (version === 1 && program.length !== 32) continue;
      return lower;
    } catch {
      /* try the other checksum */
    }
  }
  return null;
}

export function validateUtxoAddress(
  chain: 'bitcoin' | 'litecoin',
  network: UtxoNetwork,
  address: string,
): string | null {
  if (address.length < 14 || address.length > 90) return null;
  const params = UTXO_PARAMS[chain][network];
  const segwit = validateSegwit(address, params.hrp);
  if (segwit) return segwit;
  try {
    const payload = base58check.decode(address);
    if (payload.length !== 21) return null;
    const version = payload[0] ?? -1;
    return params.p2pkh.includes(version) || params.p2sh.includes(version) ? address : null;
  } catch {
    return null;
  }
}

/** EIP-55 mixed-case checksum encoding of a 20-byte address. */
export function toChecksumAddress(hex40: string): string {
  const lower = hex40.toLowerCase().replace(/^0x/, '');
  const hash = Buffer.from(keccak_256(new TextEncoder().encode(lower))).toString('hex');
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    out +=
      Number.parseInt(hash.charAt(i), 16) >= 8 ? lower.charAt(i).toUpperCase() : lower.charAt(i);
  }
  return out;
}

/**
 * Accepts all-lower or all-upper hex (no checksum) or a correct EIP-55
 * checksum. A mixed-case address with a wrong checksum is a typo and is
 * rejected. The zero address is rejected (funds sent there are burned).
 */
export function validateEvmAddress(address: string): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const body = address.slice(2);
  const checksummed = toChecksumAddress(body);
  const isMixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (isMixed && checksummed !== address) return null;
  if (/^0x0{40}$/.test(address)) return null;
  return checksummed;
}

/** Tron base58 address from the 20-byte account id shared with EVM derivation. */
export function encodeTronAddress(accountId20: Uint8Array): string {
  if (accountId20.length !== 20) throw new Error('Tron address requires 20 bytes');
  return base58check.encode(Uint8Array.from([0x41, ...accountId20]));
}

export function tronToHex(address: string): string {
  return Buffer.from(base58check.decode(address)).toString('hex');
}

export function validateTronAddress(address: string): string | null {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return null;
  try {
    const payload = base58check.decode(address);
    return payload.length === 21 && payload[0] === 0x41 ? address : null;
  } catch {
    return null;
  }
}

/** Classic r-addresses only. X-addresses are rejected to keep tag handling explicit. */
export function validateXrplAddress(address: string): string | null {
  return isValidClassicAddress(address) ? address : null;
}

export function validateAddress(
  chain: ChainFamily,
  network: NetworkMode,
  address: string,
): string | null {
  switch (chain) {
    case 'bitcoin':
    case 'litecoin':
      return validateUtxoAddress(chain, network, address);
    case 'ethereum':
      return validateEvmAddress(address);
    case 'tron':
      return validateTronAddress(address);
    case 'xrpl':
      return validateXrplAddress(address);
  }
}
