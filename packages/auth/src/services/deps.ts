import type { Db } from '@actualpay/database';
import type { Mailer } from '@actualpay/email';
import type { Logger, NetworkMode } from '@actualpay/shared';
import type { RequestMeta } from '@actualpay/audit';
import type { SecretBox } from '../crypto';

/** Everything the identity services need, passed explicitly (no globals). */
export interface AuthDeps {
  readonly db: Db;
  readonly mailer: Mailer;
  readonly logger: Logger;
  readonly appName: string;
  readonly publicBaseUrl: URL;
  readonly network: NetworkMode;
  /** Encrypts TOTP seeds at rest. */
  readonly totpBox: SecretBox;
  readonly sessionPolicy: { readonly idleMinutes: number; readonly absoluteHours: number };
  readonly lockoutPolicy: { readonly maxFailures: number; readonly lockMinutes: number };
}

export type { RequestMeta };

/**
 * Links put one-time tokens in the URL *fragment*. Fragments are not sent to
 * servers, so tokens do not end up in proxy logs, access logs or Referer
 * headers; the dashboard reads the fragment and POSTs it to the API.
 */
export function appLink(deps: AuthDeps, path: string, token: string): string {
  const url = new URL(path, deps.publicBaseUrl);
  url.hash = `token=${token}`;
  return url.toString();
}
