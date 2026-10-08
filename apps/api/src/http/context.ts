import type { AppConfig } from '@actualpay/config';
import type { AuthDeps } from '@actualpay/auth';
import type { Db } from '@actualpay/database';
import type { Logger } from '@actualpay/shared';

/** Process-wide dependencies shared by every route. */
export interface ApiContext {
  readonly config: AppConfig;
  readonly db: Db;
  readonly logger: Logger;
  readonly auth: AuthDeps;
  /** Derived key for CSRF tokens (independent of other uses of SESSION_SECRET). */
  readonly csrfKey: Buffer;
  /** Whether cookies are marked Secure (true unless running plain-HTTP development). */
  readonly secureCookies: boolean;
}
