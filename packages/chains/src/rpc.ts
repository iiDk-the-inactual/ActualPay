/**
 * Minimal HTTP/JSON client for node RPCs and REST APIs.
 *
 * - Every request has a timeout; a hung node must not hang workers.
 * - Responses are parsed with exact numbers (see exact-json.ts).
 * - Errors never include credentials: URLs are reduced to their origin.
 * - `retryable` tells callers whether trying again later can help.
 */
import { parseJsonExact } from './exact-json';

export class ChainRpcError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly rpcCode?: number,
  ) {
    super(message);
    this.name = 'ChainRpcError';
  }
}

export function safeOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(invalid url)';
  }
}

export interface HttpOptions {
  readonly timeoutMs?: number;
  readonly headers?: Record<string, string>;
}

export async function httpJson(
  url: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  options: HttpOptions = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? 15_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
      redirect: 'error',
    });
  } catch (error) {
    // Surface the low-level reason (ECONNREFUSED, ENOTFOUND, timeout) without the URL's credentials.
    const cause =
      error instanceof Error &&
      error.cause &&
      typeof error.cause === 'object' &&
      'code' in error.cause
        ? String(error.cause.code)
        : undefined;
    const reason =
      error instanceof Error && error.name === 'AbortError'
        ? 'timed out'
        : (cause ?? 'network error');
    throw new ChainRpcError(`Request to ${safeOrigin(url)} failed: ${reason}`, true);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new ChainRpcError(
      `${safeOrigin(url)} rejected the credentials (HTTP ${response.status})`,
      false,
    );
  }
  if (response.status === 429 || response.status >= 500) {
    // bitcoind reports RPC errors with HTTP 500 and a JSON body; let callers inspect it.
    try {
      return parseJsonExact(text);
    } catch {
      throw new ChainRpcError(`${safeOrigin(url)} returned HTTP ${response.status}`, true);
    }
  }
  if (!response.ok)
    throw new ChainRpcError(`${safeOrigin(url)} returned HTTP ${response.status}`, false);
  try {
    return parseJsonExact(text);
  } catch {
    throw new ChainRpcError(`${safeOrigin(url)} returned invalid JSON`, true);
  }
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
}

/** JSON-RPC 1.0/2.0 call (bitcoind and Ethereum nodes both accept this shape). */
export async function jsonRpc(
  url: string,
  method: string,
  params: readonly unknown[],
  options: HttpOptions = {},
): Promise<unknown> {
  const raw = (await httpJson(
    url,
    { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params } },
    options,
  )) as JsonRpcResponse;
  if (raw.error) {
    const code = typeof raw.error.code === 'string' ? Number(raw.error.code) : undefined;
    const message = typeof raw.error.message === 'string' ? raw.error.message : 'unknown error';
    // -28 = bitcoind warming up; -32005 = common "limit exceeded" from providers.
    const retryable = code === -28 || code === -32005 || code === -32603;
    throw new ChainRpcError(`${method}: ${message}`, retryable, code);
  }
  if (!('result' in raw)) throw new ChainRpcError(`${method}: malformed response`, true);
  return raw.result;
}

export function basicAuth(username: string, password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
}
