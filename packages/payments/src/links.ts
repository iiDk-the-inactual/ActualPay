/**
 * Payment links: a fixed-price, reusable page that creates a fresh invoice for
 * each visitor.
 *
 * The public endpoint allocates a permanent deposit address per call, so it is
 * the one place an anonymous caller can consume a finite resource. Defences:
 * a per-link cap on unpaid invoices (below), a per-organization cap (in
 * createInvoiceTx), and the strict HTTP rate limit on the route itself.
 */
import { sql } from 'kysely';
import { inTransaction, type Db, type PaymentLinkRow } from '@actualpay/database';
import { recordAudit, type RequestMeta } from '@actualpay/audit';
import {
  AppError,
  assertPositive,
  MAX_BASE_UNITS,
  type AssetId,
  type NetworkMode,
} from '@actualpay/shared';
import { createInvoiceTx, newPublicId, type InvoiceView } from './invoices';
import { LIVE_STATUSES } from './status';

export interface PaymentLinkActor {
  readonly userId: string;
}

export async function createPaymentLink(
  db: Db,
  params: {
    organizationId: string;
    actor: PaymentLinkActor;
    assetId: AssetId;
    amount: bigint;
    title: string;
    description?: string;
    invoiceTtlMinutes?: number;
    maxOpenInvoices?: number;
    enabledAssets: readonly AssetId[];
  },
  meta: RequestMeta,
): Promise<PaymentLinkRow> {
  if (!params.enabledAssets.includes(params.assetId))
    throw AppError.validation(`${params.assetId} is not enabled in this deployment.`);
  assertPositive(params.amount, 'Amount');
  if (params.amount > MAX_BASE_UNITS) throw AppError.validation('Amount is too large.');
  const title = params.title.trim();
  if (title.length < 1 || title.length > 200)
    throw AppError.validation('Title must be 1–200 characters.');
  return inTransaction(db, async (tx) => {
    const link = await tx
      .insertInto('payment_links')
      .values({
        public_id: newPublicId(),
        organization_id: params.organizationId,
        asset_id: params.assetId,
        amount: params.amount,
        title,
        description: params.description ?? null,
        ...(params.invoiceTtlMinutes !== undefined
          ? { invoice_ttl_minutes: params.invoiceTtlMinutes }
          : {}),
        ...(params.maxOpenInvoices !== undefined
          ? { max_open_invoices: params.maxOpenInvoices }
          : {}),
        created_by: params.actor.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(tx, {
      actor: { type: 'user', id: params.actor.userId },
      action: 'payment_link.created',
      organizationId: params.organizationId,
      target: { type: 'payment_link', id: link.id },
      meta,
      metadata: { assetId: params.assetId, amount: params.amount.toString() },
    });
    return link;
  });
}

export async function setPaymentLinkActive(
  db: Db,
  params: { organizationId: string; linkId: string; active: boolean; actor: PaymentLinkActor },
  meta: RequestMeta,
): Promise<PaymentLinkRow> {
  return inTransaction(db, async (tx) => {
    const link = await tx
      .updateTable('payment_links')
      .set({ active: params.active })
      .where('id', '=', params.linkId)
      .where('organization_id', '=', params.organizationId)
      .returningAll()
      .executeTakeFirst();
    if (!link) throw AppError.notFound('Payment link');
    await recordAudit(tx, {
      actor: { type: 'user', id: params.actor.userId },
      action: params.active ? 'payment_link.activated' : 'payment_link.deactivated',
      organizationId: params.organizationId,
      target: { type: 'payment_link', id: link.id },
      meta,
    });
    return link;
  });
}

export async function listPaymentLinks(db: Db, organizationId: string): Promise<PaymentLinkRow[]> {
  return db
    .selectFrom('payment_links')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .orderBy('created_at', 'desc')
    .limit(500)
    .execute();
}

export async function getPaymentLinkByPublicId(db: Db, publicId: string) {
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(publicId)) throw AppError.notFound('Payment link');
  const link = await db
    .selectFrom('payment_links')
    .innerJoin('organizations', 'organizations.id', 'payment_links.organization_id')
    .select([
      'payment_links.id',
      'payment_links.public_id',
      'payment_links.organization_id',
      'payment_links.asset_id',
      'payment_links.amount',
      'payment_links.title',
      'payment_links.description',
      'payment_links.active',
      'payment_links.invoice_ttl_minutes',
      'payment_links.max_open_invoices',
      'organizations.name as organization_name',
      'organizations.status as organization_status',
    ])
    .where('payment_links.public_id', '=', publicId)
    .executeTakeFirst();
  if (!link) throw AppError.notFound('Payment link');
  return link;
}

/** Create a fresh invoice for an anonymous visitor of a payment link. */
export async function createInvoiceFromLink(
  db: Db,
  params: { publicId: string; network: NetworkMode; enabledAssets: readonly AssetId[]; now?: Date },
  meta: RequestMeta,
): Promise<InvoiceView> {
  const link = await getPaymentLinkByPublicId(db, params.publicId);
  if (!link.active || link.organization_status !== 'active')
    throw AppError.notFound('Payment link');
  const now = params.now ?? new Date();
  return inTransaction(db, async (tx) => {
    // Serialize concurrent visitors of one link so the cap below is exact.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${link.id}, 0))`.execute(tx);
    const open = await tx
      .selectFrom('invoices')
      .select(sql<string>`count(*)`.as('n'))
      .where('payment_link_id', '=', link.id)
      .where('status', 'in', [...LIVE_STATUSES])
      .where('expires_at', '>', now)
      .executeTakeFirstOrThrow();
    if (Number(open.n) >= link.max_open_invoices) {
      throw new AppError(
        'RATE_LIMITED',
        'This payment link has too many unpaid invoices right now. Try again later.',
      );
    }
    return createInvoiceTx(
      tx,
      {
        organizationId: link.organization_id,
        actor: { type: 'payment_link', id: link.id },
        assetId: link.asset_id as AssetId,
        amount: BigInt(link.amount),
        network: params.network,
        enabledAssets: params.enabledAssets,
        expiresInMinutes: link.invoice_ttl_minutes,
        description: link.title,
        paymentLinkId: link.id,
        now,
      },
      meta,
    );
  });
}
