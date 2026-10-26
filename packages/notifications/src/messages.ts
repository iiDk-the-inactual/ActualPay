/**
 * Turns domain events and audit entries into plain-text notices.
 *
 * Plain text only. Subjects are fixed phrases (no user-controlled text, so no
 * header tricks and nothing to phish with); the body carries the details, with
 * user-controlled values on their own line and never as link targets. Links
 * point only at this deployment's dashboard.
 */
import type { NotificationKind } from '@actualpay/database';

export interface Notice {
  readonly kind: NotificationKind;
  readonly subject: string;
  /** Lines of detail; the footer and organization line are added when sending. */
  readonly lines: readonly string[];
  /** Dashboard path (hash route) the notice is about. */
  readonly path: string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const text = (v: unknown, max = 200): string =>
  typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').slice(0, max) : '';

function money(v: unknown): string {
  const m = obj(v);
  const asset = text(m['asset'], 20).toUpperCase();
  const amount = text(m['amount'], 60);
  return amount && asset ? `${amount} ${asset}` : '';
}

export function noticeForEvent(type: string, payload: unknown): Notice | null {
  const p = obj(payload);
  switch (type) {
    case 'invoice.paid':
      return {
        kind: 'payments',
        subject: 'An invoice was paid',
        lines: [
          `Amount: ${money(p['amountConfirmed'])}`,
          p['externalId'] ? `Your reference: ${text(p['externalId'])}` : '',
          p['paidLate'] === true ? 'It was paid after the invoice expired.' : '',
        ],
        path: '#/invoices',
      };
    case 'payment.reversed':
      return {
        kind: 'payment_problems',
        subject: 'A payment was reversed by the network',
        lines: [
          `Amount: ${money(p['amount'])}`,
          `Transaction: ${text(p['txHash'], 100)}`,
          'The chain reorganized and the payment no longer exists. Check the invoice before shipping goods.',
        ],
        path: '#/payments',
      };
    case 'withdrawal.requested':
      return {
        kind: 'withdrawals',
        subject: 'A withdrawal needs approval',
        lines: [
          `Amount: ${money(p['amount'])}`,
          `To: ${text(obj(p['destination'])['address'], 100)}`,
          'A second person with two-factor authentication must approve it, or reject it if you do not recognise it.',
        ],
        path: '#/withdrawals',
      };
    case 'withdrawal.approved':
      return {
        kind: 'withdrawals',
        subject: 'A withdrawal was approved',
        lines: [
          `Amount: ${money(p['amount'])}`,
          `To: ${text(obj(p['destination'])['address'], 100)}`,
        ],
        path: '#/withdrawals',
      };
    case 'withdrawal.confirmed':
      return {
        kind: 'withdrawals',
        subject: 'A withdrawal was completed',
        lines: [
          `Amount: ${money(p['amount'])}`,
          `To: ${text(obj(p['destination'])['address'], 100)}`,
          `Transaction: ${text(p['txid'], 100)}`,
        ],
        path: '#/withdrawals',
      };
    case 'withdrawal.failed':
      return {
        kind: 'withdrawals',
        subject: 'A withdrawal failed',
        lines: [
          `Amount: ${money(p['amount'])}`,
          'The funds were returned to your available balance.',
        ],
        path: '#/withdrawals',
      };
    case 'withdrawal.cancelled':
      return {
        kind: 'withdrawals',
        subject: 'A withdrawal was cancelled',
        lines: [
          `Amount: ${money(p['amount'])}`,
          'The funds were returned to your available balance.',
        ],
        path: '#/withdrawals',
      };
    default:
      return null;
  }
}

export function noticeForAudit(action: string, metadata: unknown): Notice | null {
  const m = obj(metadata);
  switch (action) {
    case 'withdrawal.policy_changed':
      return {
        kind: 'security',
        subject: 'Withdrawal limits were changed',
        lines: [
          `Asset: ${text(m['assetId'], 30)}`,
          m['enabled'] === false ? 'Withdrawals were switched off.' : '',
          m['loosening'] === true
            ? `Higher limits take effect at ${text(m['effectiveAt'], 40)}.`
            : 'The new limits are in effect.',
        ],
        path: '#/withdrawals',
      };
    case 'withdrawal.destination_added':
      return {
        kind: 'security',
        subject: 'A withdrawal destination was added',
        lines: [
          `Address: ${text(m['address'], 100)}`,
          'It cannot be used until its cool-down has passed. Revoke it now if you do not recognise it.',
        ],
        path: '#/withdrawals',
      };
    case 'withdrawal.destination_revoked':
      return {
        kind: 'security',
        subject: 'A withdrawal destination was revoked',
        lines: [`Address: ${text(m['address'], 100)}`],
        path: '#/withdrawals',
      };
    case 'withdrawal.needs_review':
      return {
        kind: 'withdrawals',
        subject: 'A withdrawal needs a human decision',
        lines: ['Funds stay on hold until a platform administrator resolves it.'],
        path: '#/withdrawals',
      };
    case 'org.api_key.created':
    case 'org.api_key.rotated':
      return {
        kind: 'security',
        subject: action.endsWith('created') ? 'An API key was created' : 'An API key was rotated',
        lines: [`Name: ${text(m['name'])}`, 'If you did not expect this, revoke the key.'],
        path: '#/keys',
      };
    case 'org.member.role_changed':
      return {
        kind: 'security',
        subject: 'A team member’s role was changed',
        lines: [`New role: ${text(m['newRole'], 30)}`],
        path: '#/team',
      };
    case 'webhook.endpoint_auto_disabled':
      return {
        kind: 'webhooks',
        subject: 'A webhook endpoint was disabled after repeated failures',
        lines: [
          'Events are no longer delivered to it. Fix the receiver and recreate the endpoint.',
        ],
        path: '#/webhooks',
      };
    default:
      return null;
  }
}

export function renderBody(params: {
  notice: Notice;
  organizationName: string;
  baseUrl: string;
  appName: string;
  actor?: string;
}): string {
  const link = new URL(`/app/${params.notice.path}`, params.baseUrl).toString();
  const lines = params.notice.lines.filter((l) => l !== '');
  return [
    `Organization:`,
    `  ${text(params.organizationName, 100)}`,
    '',
    ...lines,
    ...(params.actor ? ['', `Done by: ${params.actor}`] : []),
    '',
    `Open the dashboard: ${link}`,
    '',
    `You receive this because of your notification settings in ${params.appName}. ` +
      `Change them under Notifications in the dashboard. Never share sign-in links.`,
    '',
  ].join('\n');
}
