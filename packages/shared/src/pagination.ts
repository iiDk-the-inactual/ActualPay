/**
 * Opaque cursor pagination. Cursors are base64url JSON so clients treat
 * them as opaque; they are validated on decode because they are user input.
 */
import { AppError } from './errors';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface Page<T> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
}

export function encodeCursor(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<K extends string>(
  cursor: string,
  keys: readonly K[],
): Record<K, string> {
  try {
    if (cursor.length > 500) throw new Error('too long');
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    const out = {} as Record<K, string>;
    for (const key of keys) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`missing ${key}`);
      out[key] = String(value);
    }
    return out;
  } catch {
    throw AppError.validation('Invalid pagination cursor.');
  }
}
