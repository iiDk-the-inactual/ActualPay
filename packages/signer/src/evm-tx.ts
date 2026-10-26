/**
 * Ethereum transactions (EIP-1559, type 2) and ERC-20 transfer calldata.
 *
 * Signing is deterministic (RFC 6979) with a low-S signature, as Ethereum
 * requires. `recoverSender` re-derives the sender from the signed bytes so the
 * signer can prove, before releasing a transaction, that it will be attributed
 * to the hot wallet and not to some other address.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { accountIdFromPublicKey, toChecksumAddress } from '@actualpay/chains';
import { bytesToHex, concatBytes, hexToBytes, rlp } from './rlp';

export interface Eip1559Tx {
  readonly chainId: bigint;
  readonly nonce: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly gasLimit: bigint;
  /** 20-byte address, 0x-prefixed. */
  readonly to: string;
  readonly value: bigint;
  /** 0x-prefixed calldata, "0x" for none. */
  readonly data: string;
}

export interface SignedEvmTx {
  /** 0x-prefixed raw transaction for eth_sendRawTransaction. */
  readonly raw: string;
  /** 0x-prefixed transaction hash. */
  readonly txid: string;
}

function fields(tx: Eip1559Tx): (Uint8Array | bigint)[] {
  const to = hexToBytes(tx.to);
  if (to.length !== 20) throw new Error('Invalid recipient address');
  return [
    tx.chainId,
    tx.nonce,
    tx.maxPriorityFeePerGas,
    tx.maxFeePerGas,
    tx.gasLimit,
    to,
    tx.value,
    hexToBytes(tx.data),
    // empty access list
  ];
}

function signingHash(tx: Eip1559Tx): Uint8Array {
  const payload = rlp([...fields(tx), []]);
  return keccak_256(concatBytes([Uint8Array.of(0x02), payload]));
}

export function signEip1559(tx: Eip1559Tx, privateKey: Uint8Array): SignedEvmTx {
  if (tx.maxPriorityFeePerGas > tx.maxFeePerGas) throw new Error('Priority fee exceeds max fee');
  const signature = secp256k1.sign(signingHash(tx), privateKey, {
    prehash: false,
    format: 'recovered',
  });
  // 'recovered' format = recovery (1) || r (32) || s (32); the library enforces low-S.
  const yParity = BigInt(signature[0] ?? 0);
  const r = BigInt(`0x${bytesToHex(signature.slice(1, 33))}`);
  const s = BigInt(`0x${bytesToHex(signature.slice(33, 65))}`);
  const body = rlp([...fields(tx), [], yParity, r, s]);
  const typed = concatBytes([Uint8Array.of(0x02), body]);
  return { raw: `0x${bytesToHex(typed)}`, txid: `0x${bytesToHex(keccak_256(typed))}` };
}

export interface DecodedEip1559 {
  readonly chainId: bigint;
  readonly nonce: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly gasLimit: bigint;
  /** Lower-case 0x address. */
  readonly to: string;
  readonly value: bigint;
  readonly data: string;
}

/** Read a signed type-2 transaction back into its fields. */
export function decodeEip1559(raw: string): DecodedEip1559 {
  const bytes = hexToBytes(raw);
  if (bytes[0] !== 0x02) throw new Error('Not a type-2 transaction');
  const items = decodeRlpList(bytes.slice(1));
  if (items.length !== 12) throw new Error('Unexpected transaction shape');
  const [chainId, nonce, prio, maxFee, gas, to, value, data] = items;
  if (!chainId || !nonce || !prio || !maxFee || !gas || !to || !value || !data)
    throw new Error('Malformed transaction');
  return {
    chainId: toBig(chainId),
    nonce: toBig(nonce),
    maxPriorityFeePerGas: toBig(prio),
    maxFeePerGas: toBig(maxFee),
    gasLimit: toBig(gas),
    to: `0x${bytesToHex(to)}`,
    value: toBig(value),
    data: `0x${bytesToHex(data)}`,
  };
}

/** The address a signed type-2 transaction will be attributed to. */
export function recoverSender(raw: string): string {
  const bytes = hexToBytes(raw);
  if (bytes[0] !== 0x02) throw new Error('Not a type-2 transaction');
  const decoded = decodeRlpList(bytes.slice(1));
  if (decoded.length !== 12) throw new Error('Unexpected transaction shape');
  const [chainId, nonce, prio, maxFee, gas, to, value, data, access, yParity, r, s] = decoded;
  if (
    !chainId ||
    !nonce ||
    !prio ||
    !maxFee ||
    !gas ||
    !to ||
    !value ||
    !data ||
    !access ||
    !yParity ||
    !r ||
    !s
  )
    throw new Error('Malformed transaction');
  const unsigned = concatBytes([
    Uint8Array.of(0x02),
    rlp([
      toBig(chainId),
      toBig(nonce),
      toBig(prio),
      toBig(maxFee),
      toBig(gas),
      to,
      toBig(value),
      data,
      [],
    ]),
  ]);
  const compact = concatBytes([pad32(r), pad32(s)]);
  const signature = secp256k1.Signature.fromBytes(compact, 'compact').addRecoveryBit(
    Number(toBig(yParity)),
  );
  const publicKey = signature.recoverPublicKey(keccak_256(unsigned)).toBytes(true);
  return toChecksumAddress(bytesToHex(accountIdFromPublicKey(publicKey)));
}

const toBig = (b: Uint8Array): bigint => (b.length === 0 ? 0n : BigInt(`0x${bytesToHex(b)}`));
function pad32(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  out.set(b, 32 - b.length);
  return out;
}

/** Decode one flat RLP list of byte strings (and an empty nested list), enough for type-2 transactions. */
function decodeRlpList(bytes: Uint8Array): Uint8Array[] {
  const first = bytes[0] ?? 0;
  if (first < 0xc0) throw new Error('Expected an RLP list');
  let offset = 1;
  let length = first - 0xc0;
  if (first > 0xf7) {
    const n = first - 0xf7;
    length = Number(toBig(bytes.slice(1, 1 + n)));
    offset = 1 + n;
  }
  const end = offset + length;
  if (end !== bytes.length) throw new Error('Trailing bytes after the transaction');
  const items: Uint8Array[] = [];
  while (offset < end) {
    const b = bytes[offset] ?? 0;
    if (b < 0x80) {
      items.push(bytes.slice(offset, offset + 1));
      offset += 1;
    } else if (b <= 0xb7) {
      const len = b - 0x80;
      items.push(bytes.slice(offset + 1, offset + 1 + len));
      offset += 1 + len;
    } else if (b <= 0xbf) {
      const n = b - 0xb7;
      const len = Number(toBig(bytes.slice(offset + 1, offset + 1 + n)));
      items.push(bytes.slice(offset + 1 + n, offset + 1 + n + len));
      offset += 1 + n + len;
    } else if (b <= 0xf7) {
      const len = b - 0xc0;
      items.push(bytes.slice(offset, offset + 1 + len)); // nested list kept opaque (access list)
      offset += 1 + len;
    } else {
      throw new Error('Unsupported nested RLP');
    }
  }
  return items;
}

/** ERC-20 `transfer(address,uint256)` calldata. */
export function erc20TransferData(to: string, amount: bigint): string {
  const recipient = hexToBytes(to);
  if (recipient.length !== 20) throw new Error('Invalid recipient address');
  if (amount < 0n || amount >= 2n ** 256n) throw new RangeError('Amount out of range');
  const word = (hex: string) => hex.padStart(64, '0');
  return `0xa9059cbb${word(bytesToHex(recipient))}${word(amount.toString(16))}`;
}
