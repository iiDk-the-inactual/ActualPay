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
import * as m0005 from './0005_wallets';
import * as m0006 from './0006_invoices';
import * as m0007 from './0007_watcher';
import * as m0008 from './0008_webhooks';
import * as m0009 from './0009_withdrawals';
import * as m0010 from './0010_notifications';

export const migrations: Record<string, Migration> = {
  '0001_foundation': m0001,
  '0002_ledger': m0002,
  '0003_audit_and_idempotency': m0003,
  '0004_identity': m0004,
  '0005_wallets': m0005,
  '0006_invoices': m0006,
  '0007_watcher': m0007,
  '0008_webhooks': m0008,
  '0009_withdrawals': m0009,
  '0010_notifications': m0010,
};
