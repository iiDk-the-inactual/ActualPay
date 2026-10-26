/**
 * Bitcoin / Litecoin transactions: spend native SegWit (P2WPKH) coins from the
 * hot wallet to any standard destination (P2PKH, P2SH, P2WPKH, P2WSH, P2TR).
 *
 * Signing follows BIP143 (segwit v0), which Litecoin shares. Fees are computed
 * from the exact virtual size, using the worst-case signature length so the fee
 * rate is never undershot. `parseUtxoTx` reads a finished transaction back so
 * the signer can check, from the bytes it is about to release, that outputs and
 * amounts are exactly what was approved.
 */
import { bech32, bech32m, createBase58check } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { UTXO_PARAMS, type UtxoNetwork } from '@actualpay/chains';
import { bytesToHex, concatBytes, hexToBytes } from './rlp';

const base58check = createBase58check(sha256);
const dsha256 = (b: Uint8Array) => sha256(sha256(b));
const hash160 = (b: Uint8Array) => ripemd160(sha256(b));

export interface UtxoInput {
  readonly txid: string;
  readonly vout: number;
  /** Satoshis (or litoshis). */
  readonly amount: bigint;
}
export interface UtxoOutput {
  readonly script: Uint8Array;
  readonly amount: bigint;
}

const SEQUENCE = 0xfffffffd; // signals replaceability (BIP125)
const SIGHASH_ALL = 1;
const WORST_CASE_SIGNATURE = 73; // 72-byte DER + sighash byte
export const DUST_LIMIT = 546n;

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
function u64(n: bigint): Uint8Array {
  if (n < 0n || n >= 2n ** 64n) throw new RangeError('Amount out of range');
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}
function varInt(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return concatBytes([Uint8Array.of(0xfe), u32(n)]);
}
const reversed = (hex: string): Uint8Array => Uint8Array.from(hexToBytes(hex)).reverse();

/** The locking script that pays `address`. Only standard, well-formed addresses are accepted. */
export function scriptForAddress(
  chain: 'bitcoin' | 'litecoin',
  network: UtxoNetwork,
  address: string,
): Uint8Array {
  const params = UTXO_PARAMS[chain][network];
  const lower = address.toLowerCase();
  if (lower.startsWith(`${params.hrp}1`)) {
    // A bech32 string must be all lower-case or all upper-case.
    if (address !== lower && address !== address.toUpperCase())
      throw new Error('Mixed-case address');
    const first = bech32.decodeUnsafe(lower);
    const decoded = first ?? bech32m.decodeUnsafe(lower);
    if (!decoded || decoded.prefix !== params.hrp) throw new Error('Invalid address');
    const version = decoded.words[0];
    const program = Uint8Array.from(bech32.fromWords(decoded.words.slice(1)));
    if (version === 0) {
      if (!first) throw new Error('Version 0 addresses use bech32, not bech32m');
      if (program.length === 20) return concatBytes([Uint8Array.of(0x00, 0x14), program]);
      if (program.length === 32) return concatBytes([Uint8Array.of(0x00, 0x20), program]);
      throw new Error('Invalid witness program length');
    }
    if (version === 1 && program.length === 32) {
      if (first) throw new Error('Version 1 addresses use bech32m');
      return concatBytes([Uint8Array.of(0x51, 0x20), program]);
    }
    throw new Error('Unsupported witness version');
  }
  const payload = base58check.decode(address);
  const prefix = payload[0];
  const hash = payload.slice(1);
  if (hash.length !== 20 || prefix === undefined) throw new Error('Invalid address');
  if (params.p2pkh.includes(prefix))
    return concatBytes([Uint8Array.of(0x76, 0xa9, 0x14), hash, Uint8Array.of(0x88, 0xac)]);
  if (params.p2sh.includes(prefix))
    return concatBytes([Uint8Array.of(0xa9, 0x14), hash, Uint8Array.of(0x87)]);
  throw new Error('Address is for a different network');
}

/** The bech32 address of a compressed public key's P2WPKH output. */
export function p2wpkhScript(publicKey: Uint8Array): Uint8Array {
  return concatBytes([Uint8Array.of(0x00, 0x14), hash160(publicKey)]);
}

function serializeOutputs(outputs: readonly UtxoOutput[]): Uint8Array {
  return concatBytes(
    outputs.map((o) => concatBytes([u64(o.amount), varInt(o.script.length), o.script])),
  );
}

export interface SignedUtxoTx {
  readonly raw: string;
  readonly txid: string;
  readonly vsize: number;
}

function legacySize(nIn: number, outputs: readonly UtxoOutput[]): number {
  return (
    4 +
    varInt(nIn).length +
    nIn * 41 +
    varInt(outputs.length).length +
    outputs.reduce((n, o) => n + 8 + varInt(o.script.length).length + o.script.length, 0) +
    4
  );
}

/** Virtual size if every input were signed with the longest possible signature. */
export function worstCaseVsize(nIn: number, outputs: readonly UtxoOutput[]): number {
  const base = legacySize(nIn, outputs);
  const witness = 2 + nIn * (1 + 1 + WORST_CASE_SIGNATURE + 1 + 33);
  return Math.ceil((base * 3 + base + witness) / 4);
}

export function signP2wpkh(params: {
  inputs: readonly UtxoInput[];
  outputs: readonly UtxoOutput[];
  privateKey: Uint8Array;
}): SignedUtxoTx {
  const { inputs, outputs, privateKey } = params;
  if (inputs.length === 0 || outputs.length === 0)
    throw new Error('A transaction needs inputs and outputs');
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  const pkh = hash160(publicKey);
  const version = u32(2);
  const locktime = u32(0);
  const outpoints = inputs.map((i) => concatBytes([reversed(i.txid), u32(i.vout)]));
  const hashPrevouts = dsha256(concatBytes(outpoints));
  const hashSequence = dsha256(concatBytes(inputs.map(() => u32(SEQUENCE))));
  const hashOutputs = dsha256(serializeOutputs(outputs));
  const scriptCode = concatBytes([
    Uint8Array.of(0x19, 0x76, 0xa9, 0x14),
    pkh,
    Uint8Array.of(0x88, 0xac),
  ]);

  const witnesses = inputs.map((input, index) => {
    const preimage = concatBytes([
      version,
      hashPrevouts,
      hashSequence,
      outpoints[index] as Uint8Array,
      scriptCode,
      u64(input.amount),
      u32(SEQUENCE),
      hashOutputs,
      locktime,
      u32(SIGHASH_ALL),
    ]);
    const der = secp256k1.sign(dsha256(preimage), privateKey, { prehash: false, format: 'der' });
    const signature = concatBytes([der, Uint8Array.of(SIGHASH_ALL)]);
    return concatBytes([
      Uint8Array.of(2),
      varInt(signature.length),
      signature,
      varInt(publicKey.length),
      publicKey,
    ]);
  });

  const vin = concatBytes(
    inputs.map((_i, index) =>
      concatBytes([outpoints[index] as Uint8Array, Uint8Array.of(0), u32(SEQUENCE)]),
    ),
  );
  const vout = concatBytes([varInt(outputs.length), serializeOutputs(outputs)]);
  const legacy = concatBytes([version, varInt(inputs.length), vin, vout, locktime]);
  const full = concatBytes([
    version,
    Uint8Array.of(0x00, 0x01),
    varInt(inputs.length),
    vin,
    vout,
    ...witnesses,
    locktime,
  ]);
  const weight = legacy.length * 3 + full.length;
  return {
    raw: bytesToHex(full),
    txid: bytesToHex(Uint8Array.from(dsha256(legacy)).reverse()),
    vsize: Math.ceil(weight / 4),
  };
}

export interface SpendPlan {
  readonly inputs: readonly UtxoInput[];
  readonly outputs: readonly UtxoOutput[];
  readonly fee: bigint;
  readonly changeAmount: bigint;
}

/**
 * Choose coins and outputs for a payment. Largest coins first (deterministic).
 * Change below the dust limit is given to the miners rather than creating an
 * output nobody could economically spend.
 */
export function planSpend(params: {
  utxos: readonly UtxoInput[];
  excluded: ReadonlySet<string>;
  destination: Uint8Array;
  amount: bigint;
  changeScript: Uint8Array;
  /** Satoshis per virtual byte, integer. */
  feeRate: bigint;
}): SpendPlan {
  if (params.amount < DUST_LIMIT) throw new Error('The amount is below the dust limit');
  if (params.feeRate < 1n) throw new Error('The fee rate must be at least 1 sat/vB');
  const available = params.utxos
    .filter((u) => !params.excluded.has(`${u.txid}:${u.vout}`))
    .sort((a, b) =>
      a.amount === b.amount
        ? `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`)
        : a.amount > b.amount
          ? -1
          : 1,
    );
  const destination: UtxoOutput = { script: params.destination, amount: params.amount };
  const chosen: UtxoInput[] = [];
  let total = 0n;
  for (const utxo of available) {
    chosen.push(utxo);
    total += utxo.amount;
    const withChange = [destination, { script: params.changeScript, amount: 0n }];
    const feeWithChange = BigInt(worstCaseVsize(chosen.length, withChange)) * params.feeRate;
    const change = total - params.amount - feeWithChange;
    if (change >= DUST_LIMIT) {
      return {
        inputs: chosen,
        outputs: [destination, { script: params.changeScript, amount: change }],
        fee: feeWithChange,
        changeAmount: change,
      };
    }
    const feeNoChange = BigInt(worstCaseVsize(chosen.length, [destination])) * params.feeRate;
    if (total - params.amount >= feeNoChange) {
      // Whatever is left over (under the dust limit) becomes extra fee.
      return {
        inputs: chosen,
        outputs: [destination],
        fee: total - params.amount,
        changeAmount: 0n,
      };
    }
  }
  throw new Error('Insufficient confirmed funds in the hot wallet');
}

export interface ParsedUtxoTx {
  readonly txid: string;
  readonly inputs: readonly { txid: string; vout: number }[];
  readonly outputs: readonly { amount: bigint; script: string }[];
  readonly locktime: number;
}

/** Read a finished (segwit or legacy) transaction back into its parts. */
export function parseUtxoTx(raw: string): ParsedUtxoTx {
  const bytes = hexToBytes(raw);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 4;
  const readVarInt = (): number => {
    const first = bytes[pos++] ?? 0;
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const v = view.getUint16(pos, true);
      pos += 2;
      return v;
    }
    if (first === 0xfe) {
      const v = view.getUint32(pos, true);
      pos += 4;
      return v;
    }
    throw new Error('Unsupported var-int');
  };
  const segwit = bytes[pos] === 0x00 && bytes[pos + 1] === 0x01;
  if (segwit) pos += 2;
  const nIn = readVarInt();
  const inputs: { txid: string; vout: number }[] = [];
  for (let i = 0; i < nIn; i++) {
    const txid = bytesToHex(Uint8Array.from(bytes.slice(pos, pos + 32)).reverse());
    const vout = view.getUint32(pos + 32, true);
    pos += 36;
    const scriptLength = readVarInt();
    pos += scriptLength + 4;
    inputs.push({ txid, vout });
  }
  const nOut = readVarInt();
  const outputs: { amount: bigint; script: string }[] = [];
  for (let i = 0; i < nOut; i++) {
    const amount = view.getBigUint64(pos, true);
    pos += 8;
    const length = readVarInt();
    outputs.push({ amount, script: bytesToHex(bytes.slice(pos, pos + length)) });
    pos += length;
  }
  if (segwit) {
    for (let i = 0; i < nIn; i++) {
      const items = readVarInt();
      for (let j = 0; j < items; j++) {
        const length = readVarInt(); // read first: it advances `pos`
        pos += length;
      }
    }
  }
  const locktime = view.getUint32(pos, true);
  pos += 4;
  if (pos !== bytes.length) throw new Error('Trailing bytes after the transaction');
  // The txid is computed over the non-witness serialization.
  const legacy = segwit ? rebuildLegacy(bytes, inputs.length, outputs.length) : bytes;
  return {
    txid: bytesToHex(Uint8Array.from(dsha256(legacy)).reverse()),
    inputs,
    outputs,
    locktime,
  };

  function rebuildLegacy(all: Uint8Array, nInputs: number, nOutputs: number): Uint8Array {
    // version | inputs | outputs | locktime, skipping marker/flag and witness data.
    let p = 6;
    const readVar = (): number => {
      const first = all[p++] ?? 0;
      if (first < 0xfd) return first;
      if (first === 0xfd) {
        const v = new DataView(all.buffer, all.byteOffset, all.byteLength).getUint16(p, true);
        p += 2;
        return v;
      }
      const v = new DataView(all.buffer, all.byteOffset, all.byteLength).getUint32(p, true);
      p += 4;
      return v;
    };
    readVar(); // nIn (already known)
    const inputsStart = p - varInt(nInputs).length;
    for (let i = 0; i < nInputs; i++) {
      p += 36;
      const scriptLength = readVar(); // read first: it advances `p`
      p += scriptLength + 4;
    }
    const outputsStart = p;
    readVar();
    for (let i = 0; i < nOutputs; i++) {
      p += 8;
      const length = readVar(); // read first: it advances `p`
      p += length;
    }
    const outputsEnd = p;
    return concatBytes([
      all.slice(0, 4),
      all.slice(inputsStart, outputsStart),
      all.slice(outputsStart, outputsEnd),
      all.slice(all.length - 4),
    ]);
  }
}
