/**
 * Static migration list. Explicit imports (instead of scanning a directory)
 * keep migrations bundler-friendly and make the run order reviewable.
 * Never edit a migration that has shipped; add a new one.
 */
import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_foundation';
import * as m0002 from './0002_ledger';
import * as m0003 from './0003_audit_and_idempotency';
import * as m0004 from './0004_identity';

export const migrations: Record<string, Migration> = {
  '0001_foundation': m0001,
  '0002_ledger': m0002,
  '0003_audit_and_idempotency': m0003,
  '0004_identity': m0004,
};
