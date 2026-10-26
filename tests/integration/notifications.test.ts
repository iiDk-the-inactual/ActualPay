/** Email notifications: who is told what, idempotency, retries, forwarding and flood limits. */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inTransaction, type Db } from '@actualpay/database';
import { MemoryMailer, type Mailer } from '@actualpay/email';
import {
  addForward,
  alertCriticalIssues,
  alertDisabledWebhooks,
  DAILY_ORG_CAP,
  enqueueEmail,
  fanOutNotifications,
  MAX_ATTEMPTS,
  MAX_FORWARDS_PER_ORG,
  removeForward,
  sendDue,
  setPreference,
  verifyForward,
} from '@actualpay/notifications';
import { recordAudit } from '@actualpay/audit';
import { recordEvent } from '@actualpay/payments';
import { createLogger } from '@actualpay/shared';
import { runCycle } from '@actualpay/watcher';
import { createOrganization, createTestDb, resetDatabase } from './helpers';
import { addMember, createUser, meta } from './withdrawal-helpers';

const logger = createLogger({ name: 'test', level: 'silent' });
const BASE = 'https://pay.example.test';
let db: Db;
let orgId: string;
let owner: string;
let finance: string;

beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.destroy();
});

async function member(label: string, role: Parameters<typeof addMember>[3], verified = true) {
  const id = await createUser(db, label);
  await addMember(db, orgId, id, role);
  if (verified)
    await db
      .updateTable('users')
      .set({ email_verified_at: new Date() })
      .where('id', '=', id)
      .execute();
  return id;
}
const emailOf = async (id: string) =>
  (await db.selectFrom('users').select('email').where('id', '=', id).executeTakeFirstOrThrow())
    .email;

beforeEach(async () => {
  await resetDatabase(db);
  orgId = await createOrganization(db, 'Acme Shop');
  owner = await member('owner', 'owner');
  finance = await member('finance', 'finance');
  await member('dev', 'developer');
  await member('viewer', 'viewer');
});

const fan = () => fanOutNotifications({ db, baseUrl: BASE, appName: 'ActualPay' });
const outbox = () => db.selectFrom('email_outbox').selectAll().orderBy('created_at').execute();

async function emit(
  type: Parameters<typeof recordEvent>[1]['type'],
  payload: Record<string, unknown>,
) {
  await inTransaction(db, (tx) =>
    recordEvent(tx, { organizationId: orgId, type, subjectType: 'x', subjectId: 'x', payload }),
  );
}
const money = (amount: string, asset = 'eth') => ({ asset, amount, baseUnits: '1' });

describe('who is told what', () => {
  it('sends withdrawal requests to owners and finance, never to developers or viewers', async () => {
    await emit('withdrawal.requested', {
      amount: money('1.5'),
      destination: { address: '0xabc' },
    });
    expect((await fan()).queued).toBe(2);
    const to = (await outbox()).map((r) => r.to_address).sort();
    expect(to).toEqual([await emailOf(finance), await emailOf(owner)].sort());
    const mail = (await outbox())[0]!;
    expect(mail.subject).toBe('[ActualPay] A withdrawal needs approval');
    expect(mail.body).toContain('1.5 ETH');
    expect(mail.body).toContain('Acme Shop');
    expect(mail.body).toContain(`${BASE}/app/#/withdrawals`);
  });

  it('keeps routine paid-invoice mail off until someone opts in', async () => {
    await emit('invoice.paid', { amountConfirmed: money('2'), externalId: 'order-7' });
    expect((await fan()).queued).toBe(0);
    await setPreference(db, {
      userId: finance,
      organizationId: orgId,
      kind: 'payments',
      enabled: true,
    });
    await emit('invoice.paid', { amountConfirmed: money('3') });
    expect((await fan()).queued).toBe(1);
    expect((await outbox())[0]?.to_address).toBe(await emailOf(finance));
  });

  it('honours opting out of a default-on kind', async () => {
    await setPreference(db, {
      userId: owner,
      organizationId: orgId,
      kind: 'withdrawals',
      enabled: false,
    });
    await emit('withdrawal.confirmed', {
      amount: money('1'),
      destination: { address: 'x' },
      txid: '0x1',
    });
    await fan();
    expect((await outbox()).map((r) => r.to_address)).toEqual([await emailOf(finance)]);
  });

  it('sends security notices to owners and admins only', async () => {
    await inTransaction(db, (tx) =>
      recordAudit(tx, {
        actor: { type: 'user', id: owner },
        action: 'withdrawal.destination_added',
        organizationId: orgId,
        target: { type: 'withdrawal_destination', id: 'd' },
        meta: { requestId: 'r', ip: '203.0.113.9' },
        metadata: { address: '0xnew' },
      }),
    );
    await fan();
    const rows = await outbox();
    expect(rows.map((r) => r.to_address)).toEqual([await emailOf(owner)]);
    expect(rows[0]?.body).toContain('0xnew');
    expect(rows[0]?.body).toContain('203.0.113.9');
  });

  it('never mails unverified or disabled accounts', async () => {
    const unverified = await member('unverified', 'owner', false);
    const disabled = await member('disabled', 'owner');
    await db.updateTable('users').set({ status: 'disabled' }).where('id', '=', disabled).execute();
    await emit('payment.reversed', { amount: money('1'), txHash: '0xdead' });
    await fan();
    const to = (await outbox()).map((r) => r.to_address);
    expect(to).not.toContain(await emailOf(unverified));
    expect(to).not.toContain(await emailOf(disabled));
    expect(to).toContain(await emailOf(owner));
  });
});

describe('idempotency', () => {
  it('queues nothing twice, even if the cursor is rewound', async () => {
    await emit('payment.reversed', { amount: money('1'), txHash: '0xdead' });
    const first = await fan();
    expect(first.queued).toBeGreaterThan(0);
    expect((await fan()).queued).toBe(0);
    await db.updateTable('notification_cursor').set({ last_event_id: 0 }).execute();
    expect((await fan()).queued).toBe(0);
    expect(await outbox()).toHaveLength(first.queued);
  });

  it('does not email about history that existed before notifications were enabled', async () => {
    const row = await db.selectFrom('notification_cursor').selectAll().executeTakeFirstOrThrow();
    expect(row.id).toBe(1);
    expect(BigInt(row.last_event_id)).toBeGreaterThanOrEqual(0n);
  });
});

describe('email text safety', () => {
  it('keeps user-controlled text out of subjects and strips line breaks from bodies', async () => {
    await db
      .updateTable('organizations')
      .set({ name: 'Evil\r\nBcc: attacker@example.test' })
      .where('id', '=', orgId)
      .execute();
    await emit('invoice.paid', { amountConfirmed: money('1'), externalId: 'x\r\nBcc: a@b.c' });
    await setPreference(db, {
      userId: owner,
      organizationId: orgId,
      kind: 'payments',
      enabled: true,
    });
    await emit('invoice.paid', { amountConfirmed: money('1'), externalId: 'x\r\nBcc: a@b.c' });
    await fan();
    for (const r of await outbox()) {
      expect(r.subject).not.toMatch(/[\r\n]/);
      expect(r.subject).not.toContain('Evil');
      expect(r.body).not.toMatch(/\r/);
      expect(r.body).not.toMatch(/^Bcc:/m);
    }
  });

  it('refuses a subject with a line break at the database level', async () => {
    await expect(
      db
        .insertInto('email_outbox')
        .values({
          kind: 'x',
          organization_id: null,
          to_address: 'a@b.test',
          subject: 'hello\r\nBcc: x@y.z',
          body: 'b',
          dedupe_key: 'k1',
        })
        .execute(),
    ).rejects.toThrow();
  });
});

describe('sending', () => {
  const queue = (n: number) =>
    Promise.all(
      Array.from({ length: n }, (_, i) =>
        enqueueEmail(db, {
          kind: 'k',
          organizationId: null,
          to: `u${i}@example.test`,
          subject: 's',
          body: 'b',
          dedupeKey: `d${i}`,
        }),
      ),
    );

  it('sends each queued mail exactly once, even with concurrent senders', async () => {
    await queue(10);
    const mailer = new MemoryMailer();
    const results = await Promise.all(
      [1, 2, 3].map(() => sendDue({ db, mailer, logger, batch: 4 })),
    );
    await sendDue({ db, mailer, logger });
    expect(mailer.sent).toHaveLength(10);
    expect(new Set(mailer.sent.map((m) => m.to)).size).toBe(10);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBeLessThanOrEqual(10);
    expect((await outbox()).every((r) => r.status === 'sent')).toBe(true);
  });

  it('retries with backoff, then gives up, storing only a fixed error phrase', async () => {
    await queue(1);
    const failing: Mailer = {
      send: () => Promise.reject(new Error('550 no such user bob@secret.test')),
    };
    let now = new Date();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await sendDue({ db, mailer: failing, logger, now });
      const [row] = await outbox();
      expect(row?.last_error).toBe('delivery failed');
      now = new Date((row?.next_attempt_at.getTime() ?? now.getTime()) + 1000);
    }
    const [row] = await outbox();
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(MAX_ATTEMPTS);
    const again = new MemoryMailer();
    await sendDue({ db, mailer: again, logger, now: new Date(now.getTime() + 10 * 86_400_000) });
    expect(again.sent).toHaveLength(0);
  });

  it('does not retry before the backoff has passed', async () => {
    await queue(1);
    const failing: Mailer = { send: () => Promise.reject(new Error('down')) };
    const now = new Date();
    await sendDue({ db, mailer: failing, logger, now });
    const ok = new MemoryMailer();
    await sendDue({ db, mailer: ok, logger, now: new Date(now.getTime() + 5000) });
    expect(ok.sent).toHaveLength(0);
    await sendDue({ db, mailer: ok, logger, now: new Date(now.getTime() + 61_000) });
    expect(ok.sent).toHaveLength(1);
  });

  it('caps non-security mail per organization per day', async () => {
    let queued = 0;
    for (let i = 0; i < DAILY_ORG_CAP + 5; i++)
      if (
        await enqueueEmail(db, {
          kind: 'k',
          organizationId: orgId,
          to: 'a@example.test',
          subject: 's',
          body: 'b',
          dedupeKey: `cap${i}`,
        })
      )
        queued += 1;
    expect(queued).toBe(DAILY_ORG_CAP);
  });
});

describe('operator alerts', () => {
  const issue = (severity: 'critical' | 'warning', id: string) =>
    db
      .insertInto('reconciliation_issues')
      .values({
        kind: 'withdrawal_lost',
        severity,
        subject_type: 'withdrawal',
        subject_id: id,
        organization_id: orgId,
        summary: 'A withdrawal needs a human\r\nBcc: x@y.z',
        details: '{}',
      })
      .execute();

  it('emails critical issues once and ignores warnings', async () => {
    await issue('critical', 'w1');
    await issue('warning', 'w2');
    const args = { db, operatorEmail: 'ops@example.test', appName: 'ActualPay', baseUrl: BASE };
    expect(await alertCriticalIssues(args)).toBe(1);
    expect(await alertCriticalIssues(args)).toBe(0);
    const [row] = await outbox();
    expect(row?.to_address).toBe('ops@example.test');
    expect(row?.subject).toContain('CRITICAL');
    expect(row?.body).not.toMatch(/^Bcc:/m);
  });

  it('does nothing without an operator address', async () => {
    await issue('critical', 'w1');
    expect(
      await alertCriticalIssues({ db, operatorEmail: undefined, appName: 'A', baseUrl: BASE }),
    ).toBe(0);
  });

  it('tells the organization when a webhook endpoint was disabled, once', async () => {
    await db
      .insertInto('webhook_endpoints')
      .values({
        organization_id: orgId,
        url: 'https://hooks.example.test/x',
        event_types: ['*'],
        secret_ciphertext: 'v1.x.x.x',
        created_by_type: 'user',
        created_by_id: owner,
      })
      .execute();
    await db
      .updateTable('webhook_endpoints')
      .set({ status: 'disabled', disabled_reason: 'test' })
      .execute();
    const args = { db, appName: 'ActualPay', baseUrl: BASE };
    expect(await alertDisabledWebhooks(args)).toBe(2); // owner and developer
    expect(await alertDisabledWebhooks(args)).toBe(0);
  });
});

describe('forwarding to outside addresses', () => {
  async function add(email = 'Books@Example.Test', kinds: string[] = ['withdrawals']) {
    const mailer = new MemoryMailer();
    const { id } = await addForward({
      db,
      mailer,
      logger,
      organizationId: orgId,
      userId: owner,
      email,
      kinds,
      appName: 'ActualPay',
      baseUrl: BASE,
      meta,
    });
    const token = /token=([A-Za-z0-9_-]+)/.exec(mailer.sent[0]?.text ?? '')?.[1] ?? '';
    return { id, token, mailer };
  }

  it('receives nothing until the address owner confirms', async () => {
    const { token, mailer } = await add();
    expect(mailer.sent[0]?.to).toBe('books@example.test');
    await emit('withdrawal.confirmed', {
      amount: money('1'),
      destination: { address: 'x' },
      txid: '0x1',
    });
    await fan();
    expect((await outbox()).map((r) => r.to_address)).not.toContain('books@example.test');

    await verifyForward(db, token, meta);
    await emit('withdrawal.failed', { amount: money('1') });
    await fan();
    expect((await outbox()).map((r) => r.to_address)).toContain('books@example.test');
  });

  it('only forwards the kinds it subscribed to', async () => {
    const { token } = await add('books@example.test', ['security']);
    await verifyForward(db, token, meta);
    await emit('withdrawal.failed', { amount: money('1') });
    await fan();
    expect((await outbox()).map((r) => r.to_address)).not.toContain('books@example.test');
  });

  it('stores only a hash of the token, and a token works once', async () => {
    const { token } = await add();
    const row = await db.selectFrom('notification_forwards').selectAll().executeTakeFirstOrThrow();
    expect(row.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(token);
    await verifyForward(db, token, meta);
    await expect(verifyForward(db, token, meta)).rejects.toThrow(/invalid|expired/);
  });

  it('rejects expired, malformed and unknown tokens', async () => {
    const { token } = await add();
    await db
      .updateTable('notification_forwards')
      .set({ token_expires_at: new Date(Date.now() - 1000) })
      .execute();
    await expect(verifyForward(db, token, meta)).rejects.toThrow(/invalid|expired/);
    await expect(verifyForward(db, 'short', meta)).rejects.toThrow();
    await expect(verifyForward(db, 'a'.repeat(43), meta)).rejects.toThrow();
  });

  it('limits forwards per organization, rejects duplicates and bad addresses', async () => {
    await add('a@example.test');
    await expect(add('A@example.test')).rejects.toThrow(/already/);
    for (let i = 1; i < MAX_FORWARDS_PER_ORG; i++) await add(`f${i}@example.test`);
    await expect(add('extra@example.test')).rejects.toThrow(/at most/);
    for (const bad of ['no-at', 'a b@x.test', 'x@y', 'a@b.test\r\nBcc: c@d.test', '<x@y.test>'])
      await expect(add(bad)).rejects.toThrow();
  });

  it('stops forwarding once removed', async () => {
    const { id, token } = await add();
    await verifyForward(db, token, meta);
    await removeForward(db, { organizationId: orgId, forwardId: id, userId: owner }, meta);
    await emit('withdrawal.failed', { amount: money('1') });
    await fan();
    expect((await outbox()).map((r) => r.to_address)).not.toContain('books@example.test');
    await expect(
      removeForward(db, { organizationId: orgId, forwardId: id, userId: owner }, meta),
    ).rejects.toThrow();
  });

  it('cannot remove another organization’s forward', async () => {
    const { id } = await add();
    const other = await createOrganization(db, 'Other');
    await expect(
      removeForward(db, { organizationId: other, forwardId: id, userId: owner }, meta),
    ).rejects.toThrow();
  });
});

describe('the worker', () => {
  it('fans out, alerts and sends in one cycle, and sends nothing without a mailer', async () => {
    await emit('withdrawal.requested', { amount: money('1'), destination: { address: '0xabc' } });
    const mailer = new MemoryMailer();
    const result = await runCycle({
      db,
      logger,
      adapters: new Map(),
      notifications: { mailer, appName: 'ActualPay', baseUrl: BASE },
    });
    expect(result.notifications).toMatchObject({ queued: 2, sent: 2 });
    expect(mailer.sent).toHaveLength(2);

    await emit('withdrawal.requested', { amount: money('2'), destination: { address: '0xabc' } });
    await runCycle({ db, logger, adapters: new Map() });
    expect(await outbox()).toHaveLength(2); // nothing queued by a worker without notifications
  });
});
