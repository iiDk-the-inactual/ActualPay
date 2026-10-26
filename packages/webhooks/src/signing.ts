/**
 * Webhook signatures.
 *
 * Header: `ActualPay-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]`
 * where v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). During a secret rotation
 * the header carries one `v1` per active secret, so receivers can switch with no
 * downtime. Receivers must verify against the RAW body, compare in constant
 * time, and reject timestamps outside a tolerance (default 5 minutes) to stop
 * replays.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

export function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function signatureHeader(
  secrets: readonly string[],
  timestamp: number,
  body: string,
): string {
  const signatures = secrets.map((s) => `v1=${computeSignature(s, timestamp, body)}`);
  return [`t=${timestamp}`, ...signatures].join(',');
}

/** Reference verifier (what a receiver should do). */
export function verifySignature(params: {
  header: string;
  body: string;
  secret: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): boolean {
  const parts = params.header.split(',').map((p) => p.trim());
  const t = parts.find((p) => p.startsWith('t='))?.slice(2);
  const timestamp = t !== undefined && /^[0-9]{1,12}$/.test(t) ? Number(t) : NaN;
  if (!Number.isFinite(timestamp)) return false;
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (params.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(computeSignature(params.secret, timestamp, params.body), 'hex');
  return parts
    .filter((p) => p.startsWith('v1='))
    .some((p) => {
      const candidate = Buffer.from(p.slice(3), 'hex');
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });
}
