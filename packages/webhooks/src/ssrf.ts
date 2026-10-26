/**
 * Server-side request forgery protection for outgoing webhooks.
 *
 * A webhook URL is attacker-controlled input that makes OUR servers send
 * requests. Without these rules a merchant could aim one at the cloud metadata
 * service (169.254.169.254), the database, Redis, an internal admin panel or a
 * blockchain node, and read the result or trigger side effects.
 *
 * Rules, enforced at registration and again at every delivery:
 *  - https only (http only when explicitly allowed for local development);
 *  - no credentials in the URL;
 *  - no loopback, private, link-local, carrier-grade NAT, multicast, reserved or
 *    unspecified addresses, in IPv4, IPv6, IPv4-mapped IPv6, NAT64 or 6to4 form;
 *  - no `localhost`/`.local`/`.internal`-style names.
 *
 * Hostnames are resolved at delivery time and the address actually connected to
 * is the one that was checked (see http.ts), so a name that resolves to a public
 * address at registration and a private one later (DNS rebinding) is refused.
 */
import { BlockList, isIP } from 'node:net';
import { AppError } from '@actualpay/shared';

export interface UrlPolicy {
  /** Allow plain http (development only). */
  readonly allowHttp: boolean;
  /** Allow private and loopback destinations (development only). */
  readonly allowPrivateNetworks: boolean;
}

const forbidden = new BlockList();
const v4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
for (const [net, prefix] of v4) forbidden.addSubnet(net, prefix, 'ipv4');
const v6: ReadonlyArray<readonly [string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['100::', 64],
];
for (const [net, prefix] of v6) forbidden.addSubnet(net, prefix, 'ipv6');

/** True if connecting to this literal address must be refused. */
export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return forbidden.check(address, 'ipv4');
  if (family !== 6) return true; // not an IP at all: refuse
  const lower = address.toLowerCase();
  if (forbidden.check(lower, 'ipv6')) return true;
  // IPv4 embedded in IPv6: mapped (::ffff:a.b.c.d / ::ffff:xxxx:xxxx), NAT64 (64:ff9b::/96), 6to4 (2002::/16).
  const dotted = /(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted?.[1]) return isForbiddenAddress(dotted[1]);
  const groups = expandIpv6(lower);
  if (!groups) return true;
  const embed = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff)
    return isForbiddenAddress(embed(groups[6] ?? 0, groups[7] ?? 0));
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0))
    return isForbiddenAddress(embed(groups[6] ?? 0, groups[7] ?? 0));
  if (groups[0] === 0x2002) return isForbiddenAddress(embed(groups[1] ?? 0, groups[2] ?? 0));
  return false;
}

function expandIpv6(address: string): number[] | null {
  let text = address;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const parts = tail.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
      return null;
    const [a = 0, b = 0, c = 0, d = 0] = parts;
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves[1] !== undefined && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const all = [...head, ...Array<string>(fill).fill('0'), ...rest].map((g) => parseInt(g, 16));
  return all.length === 8 && all.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? all
    : null;
}

const FORBIDDEN_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/i;

/** Validate a webhook URL's shape. Does not resolve DNS (delivery does). */
export function validateWebhookUrl(raw: string, policy: UrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw AppError.validation('The webhook URL is not a valid URL.');
  }
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:'))
    throw AppError.validation('The webhook URL must use https.');
  if (url.username || url.password)
    throw AppError.validation('The webhook URL must not contain credentials.');
  if (url.hash) throw AppError.validation('The webhook URL must not contain a fragment.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw AppError.validation('The webhook URL needs a host name.');
  if (!policy.allowPrivateNetworks) {
    if (isIP(host) !== 0) {
      if (isForbiddenAddress(host))
        throw AppError.validation('The webhook URL points to a private or reserved address.');
    } else if (FORBIDDEN_NAME.test(host) || !host.includes('.')) {
      throw AppError.validation('The webhook URL must use a public host name.');
    }
  }
  return url;
}
