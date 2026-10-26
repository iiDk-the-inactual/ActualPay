/** Minimal RLP encoder (Ethereum's serialisation), enough for transactions. */
export type RlpInput = Uint8Array | bigint | number | string | readonly RlpInput[];

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function bigintToBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new RangeError('RLP cannot encode a negative number');
  if (value === 0n) return new Uint8Array(0); // zero is the empty byte string
  const hex = value.toString(16);
  return Uint8Array.from(Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex'));
}

function lengthPrefix(length: number, offset: number): Uint8Array {
  if (length < 56) return Uint8Array.of(offset + length);
  const lengthBytes = bigintToBytes(BigInt(length));
  return concat([Uint8Array.of(offset + 55 + lengthBytes.length), lengthBytes]);
}

export function rlp(input: RlpInput): Uint8Array {
  if (Array.isArray(input)) {
    const body = concat((input as readonly RlpInput[]).map(rlp));
    return concat([lengthPrefix(body.length, 0xc0), body]);
  }
  let bytes: Uint8Array;
  if (input instanceof Uint8Array) bytes = input;
  else if (typeof input === 'bigint') bytes = bigintToBytes(input);
  else if (typeof input === 'number') {
    if (!Number.isSafeInteger(input)) throw new RangeError('RLP number must be a safe integer');
    bytes = bigintToBytes(BigInt(input));
  } else if (typeof input === 'string') bytes = new TextEncoder().encode(input);
  else throw new TypeError('Unsupported RLP input');
  if (bytes.length === 1 && (bytes[0] ?? 0) < 0x80) return bytes;
  return concat([lengthPrefix(bytes.length, 0x80), bytes]);
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error('Invalid hex');
  return Uint8Array.from(Buffer.from(clean, 'hex'));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export { concat as concatBytes };
