/**
 * Typed accessors for untrusted JSON from nodes and APIs. Remote data is
 * never cast blindly: each field is checked, and malformed responses raise
 * a ChainRpcError instead of producing wrong numbers.
 */
import { ChainRpcError } from './rpc';

export type Json = unknown;

export function obj(value: Json, what: string): Record<string, Json> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ChainRpcError(`malformed ${what}`, true);
  return value as Record<string, Json>;
}

export function arr(value: Json, what: string): Json[] {
  if (!Array.isArray(value)) throw new ChainRpcError(`malformed ${what}`, true);
  return value;
}

export function str(value: Json, what: string): string {
  if (typeof value !== 'string') throw new ChainRpcError(`malformed ${what}`, true);
  return value;
}

export function optStr(value: Json): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** An integer that arrived as an exact source string (see exact-json) or a safe JS number. */
export function int(value: Json, what: string): bigint {
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new ChainRpcError(`malformed ${what}`, true);
}

export function hexInt(value: Json, what: string): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value))
    throw new ChainRpcError(`malformed ${what}`, true);
  return BigInt(value);
}

export function bool(value: Json, what: string): boolean {
  if (typeof value !== 'boolean') throw new ChainRpcError(`malformed ${what}`, true);
  return value;
}
