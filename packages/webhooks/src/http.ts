/**
 * The single place the platform makes an outbound request to a merchant.
 *
 * Hostnames are resolved by our own `lookup`, which rejects forbidden addresses,
 * and the socket connects to the address that passed, so there is no gap for DNS
 * rebinding. Redirects are never followed (a 3xx is a failure), the response
 * body is never trusted or stored, and every request has a hard timeout.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { isForbiddenAddress, validateWebhookUrl, type UrlPolicy } from './ssrf';

export const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;

export type PostResult =
  | { readonly ok: true; readonly statusCode: number }
  | { readonly ok: false; readonly statusCode?: number; readonly error: string };

/** Resolves a hostname to candidate addresses (injectable for tests). */
export type Resolver = (hostname: string) => Promise<readonly string[]>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses: LookupAddress[]) => {
      if (error) reject(error);
      else resolve(addresses.map((a) => a.address));
    });
  });

export async function postJson(params: {
  url: string;
  body: string;
  headers: Record<string, string>;
  policy: UrlPolicy;
  timeoutMs?: number;
  resolver?: Resolver;
}): Promise<PostResult> {
  if (Buffer.byteLength(params.body) > MAX_BODY_BYTES)
    return { ok: false, error: 'payload too large' };
  let url: URL;
  try {
    url = validateWebhookUrl(params.url, params.policy);
  } catch {
    return { ok: false, error: 'destination not allowed' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');

  // Choose the address now, check it, and connect to exactly that address.
  let address = host;
  if (isIP(host) === 0) {
    let candidates: readonly string[];
    try {
      candidates = await (params.resolver ?? systemResolver)(host);
    } catch {
      return { ok: false, error: 'dns lookup failed' };
    }
    const usable = params.policy.allowPrivateNetworks
      ? candidates
      : candidates.filter((a) => !isForbiddenAddress(a));
    // If ANY answer is forbidden, refuse outright: do not quietly pick the public one.
    if (candidates.length === 0 || usable.length !== candidates.length)
      return { ok: false, error: 'destination not allowed' };
    address = usable[0] ?? host;
  } else if (!params.policy.allowPrivateNetworks && isForbiddenAddress(host)) {
    return { ok: false, error: 'destination not allowed' };
  }

  const transport = url.protocol === 'https:' ? https : http;
  return new Promise<PostResult>((resolve) => {
    let settled = false;
    const done = (result: PostResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = transport.request(
      {
        host: address,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        method: 'POST',
        path: `${url.pathname}${url.search}`,
        headers: {
          ...params.headers,
          Host: url.host,
          'Content-Length': Buffer.byteLength(params.body).toString(),
        },
        // Verify the certificate against the original host name, not the IP.
        ...(url.protocol === 'https:' && isIP(host) === 0 ? { servername: host } : {}),
        timeout: params.timeoutMs ?? DELIVERY_TIMEOUT_MS,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        // Drain a bounded amount, then drop the connection; the body is never used.
        let seen = 0;
        response.on('data', (chunk: Buffer) => {
          seen += chunk.length;
          if (seen > 4096) response.destroy();
        });
        response.on('end', () => {
          finish(status);
        });
        response.on('close', () => {
          finish(status);
        });
        response.on('error', () => {
          finish(status);
        });
        function finish(code: number) {
          if (code >= 200 && code < 300) done({ ok: true, statusCode: code });
          else done({ ok: false, statusCode: code, error: `HTTP ${code}` });
        }
      },
    );
    request.on('timeout', () => {
      request.destroy();
      done({ ok: false, error: 'timeout' });
    });
    request.on('error', (error: NodeJS.ErrnoException) => {
      done({ ok: false, error: classify(error) });
    });
    request.end(params.body);
  });
}

/** Short, fixed phrases only: error text from the peer is never stored. */
function classify(error: NodeJS.ErrnoException): string {
  switch (error.code) {
    case 'ECONNREFUSED':
      return 'connection refused';
    case 'ECONNRESET':
      return 'connection reset';
    case 'ETIMEDOUT':
      return 'timeout';
    case 'ENOTFOUND':
      return 'dns lookup failed';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'tls certificate rejected';
    default:
      return 'request failed';
  }
}
