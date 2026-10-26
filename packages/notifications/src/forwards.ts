/**
 * Optional forwarding of organization notifications to an outside address
 * (an accounting inbox, a shared mailbox). The address owner must confirm by
 * clicking a link we email them; until then it receives nothing, so the feature
 * cannot be used to spam a third party. Tokens are random, stored only as a
 * SHA-256 hash, expire in 48 hours and work once.
 */
import { createHash, randomBytes } from 'node:crypto';
import { inTransaction, type Db } from '@actualpay/database';
import { recordAudit, type RequestMeta } from '@actualpay/audit';
import { sendSafely, type Mailer } from '@actualpay/email';
import { AppError, type Logger } from '@actualpay/shared';
import { NOTIFICATION_KINDS, isNotificationKind } from './kinds';

export const MAX_FORWARDS_PER_ORG = 5;
const TOKEN_HOURS = 48;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

const EMAIL = /^[^\s@<>()[\],;:"\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/;

export function normalizeForwardEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email))
    throw AppError.validation('Enter a valid email address.');
  return email;
}

export async function addForward(params: {
  db: Db;
  mailer: Mailer;
  logger: Logger;
  organizationId: string;
  userId: string;
  email: string;
  kinds: readonly string[];
  appName: string;
  baseUrl: string;
  meta: RequestMeta;
}): Promise<{ id: string }> {
  const email = normalizeForwardEmail(params.email);
  const kinds = [...new Set(params.kinds)];
  if (kinds.length === 0) throw AppError.validation('Choose at least one kind of notification.');
  const valid = kinds.filter(isNotificationKind);
  if (valid.length !== kinds.length) throw AppError.validation('Unknown notification kind.');
  const token = randomBytes(32).toString('base64url');

  const id = await inTransaction(params.db, async (tx) => {
    const active = await tx
      .selectFrom('notification_forwards')
      .select('id')
      .where('organization_id', '=', params.organizationId)
      .where('status', '!=', 'removed')
      .execute();
    if (active.length >= MAX_FORWARDS_PER_ORG)
      throw AppError.conflict(`An organization can have at most ${MAX_FORWARDS_PER_ORG} forwards.`);
    const row = await tx
      .insertInto('notification_forwards')
      .values({
        organization_id: params.organizationId,
        email,
        kinds: valid,
        token_hash: hash(token),
        token_expires_at: new Date(Date.now() + TOKEN_HOURS * 3_600_000),
        created_by: params.userId,
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'email']).where('status', '<>', 'removed').doNothing(),
      )
      .returning('id')
      .executeTakeFirst();
    if (!row) throw AppError.conflict('That address is already forwarding for this organization.');
    await recordAudit(tx, {
      actor: { type: 'user', id: params.userId },
      action: 'notification.forward_added',
      organizationId: params.organizationId,
      target: { type: 'notification_forward', id: row.id },
      meta: params.meta,
      metadata: { email, kinds: valid },
    });
    return row.id;
  });

  const org = await params.db
    .selectFrom('organizations')
    .select('name')
    .where('id', '=', params.organizationId)
    .executeTakeFirst();
  const link = new URL(`/app/#/verify-forward?token=${token}`, params.baseUrl).toString();
  await sendSafely(
    params.mailer,
    {
      to: email,
      subject: `Confirm notification forwarding from ${params.appName}`,
      text:
        `Someone asked ${params.appName} to forward notifications for this organization to your address:\n\n` +
        `  ${(org?.name ?? '').replace(/[\r\n]+/g, ' ').slice(0, 100)}\n\n` +
        `Confirm only if you expect this:\n\n${link}\n\nThis link expires in ${TOKEN_HOURS} hours. ` +
        `If you do nothing, you will receive nothing.\n`,
    },
    params.logger,
  );
  return { id };
}

export async function verifyForward(db: Db, token: string, meta: RequestMeta): Promise<void> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token))
    throw AppError.validation('This confirmation link is invalid.');
  await inTransaction(db, async (tx) => {
    const row = await tx
      .selectFrom('notification_forwards')
      .selectAll()
      .where('token_hash', '=', hash(token))
      .where('status', '=', 'pending')
      .forUpdate()
      .executeTakeFirst();
    if (!row || !row.token_expires_at || row.token_expires_at.getTime() < Date.now())
      throw AppError.validation('This confirmation link is invalid or has expired.');
    await tx
      .updateTable('notification_forwards')
      .set({ status: 'active', verified_at: new Date(), token_hash: null, token_expires_at: null })
      .where('id', '=', row.id)
      .execute();
    await recordAudit(tx, {
      actor: { type: 'system' },
      action: 'notification.forward_verified',
      organizationId: row.organization_id,
      target: { type: 'notification_forward', id: row.id },
      meta,
      metadata: { email: row.email },
    });
  });
}

export async function removeForward(
  db: Db,
  params: { organizationId: string; forwardId: string; userId: string },
  meta: RequestMeta,
): Promise<void> {
  await inTransaction(db, async (tx) => {
    const row = await tx
      .updateTable('notification_forwards')
      .set({ status: 'removed', token_hash: null, token_expires_at: null })
      .where('id', '=', params.forwardId)
      .where('organization_id', '=', params.organizationId)
      .where('status', '!=', 'removed')
      .returning(['id', 'email'])
      .executeTakeFirst();
    if (!row) throw AppError.notFound('Forward');
    await recordAudit(tx, {
      actor: { type: 'user', id: params.userId },
      action: 'notification.forward_removed',
      organizationId: params.organizationId,
      target: { type: 'notification_forward', id: row.id },
      meta,
      metadata: { email: row.email },
    });
  });
}

export async function listForwards(db: Db, organizationId: string) {
  return db
    .selectFrom('notification_forwards')
    .select(['id', 'email', 'kinds', 'status', 'verified_at', 'created_at'])
    .where('organization_id', '=', organizationId)
    .where('status', '!=', 'removed')
    .orderBy('created_at', 'desc')
    .execute();
}

export { NOTIFICATION_KINDS };
