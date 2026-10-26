/**
 * Notification kinds, who may receive them and whether they are on by default.
 *
 * Defaults lean toward telling people about money leaving and security changes,
 * and away from routine payment chatter (that is what webhooks are for).
 */
import type { NotificationKind } from '@actualpay/database';

export const NOTIFICATION_KINDS = [
  'payments',
  'payment_problems',
  'withdrawals',
  'security',
  'webhooks',
] as const satisfies readonly NotificationKind[];

type Role = 'owner' | 'admin' | 'finance' | 'developer' | 'viewer';

export const KIND_INFO: Readonly<
  Record<NotificationKind, { label: string; roles: readonly Role[]; defaultOn: boolean }>
> = {
  payments: {
    label: 'Invoices paid',
    roles: ['owner', 'admin', 'finance'],
    defaultOn: false,
  },
  payment_problems: {
    label: 'Payment problems (reversed payments)',
    roles: ['owner', 'admin', 'finance'],
    defaultOn: true,
  },
  withdrawals: {
    label: 'Withdrawal requests and results',
    roles: ['owner', 'admin', 'finance'],
    defaultOn: true,
  },
  security: {
    label: 'Security changes (limits, destinations, API keys, roles)',
    roles: ['owner', 'admin'],
    defaultOn: true,
  },
  webhooks: {
    label: 'Webhook endpoint problems',
    roles: ['owner', 'admin', 'developer'],
    defaultOn: true,
  },
};

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value);
}
