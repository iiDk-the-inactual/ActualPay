/**
 * Invoices, payments and payment links.
 *
 * Amounts cross the API as decimal strings in the asset's display unit
 * ("0.0015") and are returned both ways ({ amount, baseUnits }). They are
 * parsed strictly (no rounding, no exponents) and held as bigint internally.
 *
 * Two endpoints are public (no login): the hosted invoice view, and creating
 * an invoice from a payment link. They expose only what a payer needs and sit
 * behind the strict per-IP rate limit.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  ASSET_IDS,
  ASSETS,
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  encodeCursor,
  MAX_PAGE_SIZE,
  parseAmount,
  type AssetId,
} from '@actualpay/shared';
import {
  cancelInvoice,
  createInvoice,
  createInvoiceFromLink,
  createPaymentLink,
  getInvoice,
  getInvoiceByPublicId,
  getPaymentLinkByPublicId,
  listInvoices,
  listPayments,
  listPaymentLinks,
  moneyView,
  paymentUri,
  setPaymentLinkActive,
  type InvoiceView,
} from '@actualpay/payments';
import type { PaymentLinkRow, PaymentRow } from '@actualpay/database';
import type { OrgAccess, SessionPrincipal } from '@actualpay/auth';
import type { ApiContext } from '../http/context';
import { auditActor, type Principal } from '../http/principal';
import { defineRoute } from '../http/route';
import { isoDate, nullableIsoDate, orgParams, uuid } from './schemas';

function orgIdOf(access: OrgAccess | null): string {
  if (!access) throw AppError.notFound('Organization');
  return access.organizationId;
}

function sessionOf(principal: Principal | null): SessionPrincipal {
  if (principal?.kind !== 'session') throw AppError.unauthenticated();
  return principal.session;
}

function callerOf(principal: Principal | null): { type: 'user' | 'api_key'; id: string } {
  if (!principal) throw AppError.unauthenticated();
  const actor = auditActor(principal);
  if (actor.type === 'system') throw AppError.unauthenticated();
  return actor;
}

const assetIdSchema = z.enum(ASSET_IDS);
const invoiceStatusSchema = z.enum([
  'open',
  'processing',
  'partially_paid',
  'paid',
  'expired',
  'cancelled',
]);
const money = z.object({ asset: z.string(), amount: z.string(), baseUnits: z.string() });

const invoiceParams = z.object({ orgId: uuid, invoiceId: uuid });
const linkParams = z.object({ orgId: uuid, linkId: uuid });
const publicParams = z.object({ publicId: z.string().min(22).max(64) });

const invoiceSchema = z.object({
  id: z.string(),
  publicId: z.string(),
  status: invoiceStatusSchema,
  externalId: z.string().nullable(),
  description: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  amountDue: money,
  amountConfirmed: money,
  amountPending: money,
  deposit: z.object({
    chain: z.string(),
    address: z.string(),
    destinationTag: z.number().nullable(),
    paymentUri: z.string().nullable(),
  }),
  hostedUrl: z.string(),
  expiresAt: isoDate,
  paidAt: nullableIsoDate,
  paidLate: z.boolean(),
  paymentLinkId: z.string().nullable(),
  createdAt: isoDate,
});

const paymentSchema = z.object({
  id: z.string(),
  invoiceId: z.string(),
  ref: z.string(),
  txHash: z.string(),
  status: z.enum(['pending', 'confirmed', 'reversed']),
  amount: money,
  countsTowardInvoice: z.boolean(),
  confirmations: z.string(),
  detectedAt: isoDate,
  confirmedAt: nullableIsoDate,
  reversedAt: nullableIsoDate,
});

const linkSchema = z.object({
  id: z.string(),
  publicId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  amount: money,
  invoiceTtlMinutes: z.number(),
  maxOpenInvoices: z.number(),
  active: z.boolean(),
  url: z.string(),
  createdAt: isoDate,
});

export function registerInvoiceRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const hostedUrl = (publicId: string) =>
    new URL(`/pay/${publicId}`, ctx.config.publicBaseUrl).toString();
  const linkUrl = (publicId: string) =>
    new URL(`/pay/link/${publicId}`, ctx.config.publicBaseUrl).toString();

  const toInvoice = (i: InvoiceView) => {
    const due = BigInt(i.amount_due);
    return {
      id: i.id,
      publicId: i.public_id,
      status: i.status,
      externalId: i.external_id,
      description: i.description,
      metadata: i.metadata,
      amountDue: moneyView(i.asset_id, due),
      amountConfirmed: moneyView(i.asset_id, BigInt(i.amount_confirmed)),
      amountPending: moneyView(i.asset_id, BigInt(i.amount_pending)),
      deposit: {
        chain: ASSETS[i.asset_id as AssetId].chain,
        address: i.address,
        destinationTag: i.destination_tag === null ? null : Number(i.destination_tag),
        paymentUri: paymentUri({ assetId: i.asset_id, address: i.address, amount: due }),
      },
      hostedUrl: hostedUrl(i.public_id),
      expiresAt: i.expires_at,
      paidAt: i.paid_at,
      paidLate: i.paid_late,
      paymentLinkId: i.payment_link_id,
      createdAt: i.created_at,
    };
  };

  const toPayment = (p: PaymentRow) => ({
    id: p.id,
    invoiceId: p.invoice_id,
    ref: p.ref,
    txHash: p.tx_hash,
    status: p.status,
    amount: moneyView(p.asset_id, BigInt(p.amount)),
    countsTowardInvoice: p.counts_toward_invoice,
    confirmations: p.confirmations,
    detectedAt: p.detected_at,
    confirmedAt: p.confirmed_at,
    reversedAt: p.reversed_at,
  });

  const toLink = (l: PaymentLinkRow) => ({
    id: l.id,
    publicId: l.public_id,
    title: l.title,
    description: l.description,
    amount: moneyView(l.asset_id, BigInt(l.amount)),
    invoiceTtlMinutes: l.invoice_ttl_minutes,
    maxOpenInvoices: l.max_open_invoices,
    active: l.active,
    url: linkUrl(l.public_id),
    createdAt: l.created_at,
  });

  const pageQuery = z.object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    cursor: z.string().max(500).optional(),
  });
  const cursorOf = (cursor: string | undefined) =>
    cursor ? decodeCursor(cursor, ['createdAt', 'id']) : undefined;
  const nextCursor = (rows: readonly { created_at: Date; id: string }[], limit: number) => {
    const last = rows.at(limit - 1);
    return rows.length > limit && last
      ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id })
      : null;
  };

  // ---------------------------------------------------------------- invoices
  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/organizations/:orgId/invoices',
    summary: 'Create an invoice (allocates a fresh deposit address)',
    tags: ['invoices'],
    auth: 'session_or_api_key',
    org: 'invoice:create',
    idempotency: 'optional',
    params: orgParams,
    body: z
      .object({
        asset: assetIdSchema,
        amount: z.string().min(1).max(80),
        walletId: uuid.optional(),
        externalId: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(2000).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        expiresInMinutes: z.number().int().optional(),
      })
      .strict(),
    response: invoiceSchema,
    successStatus: 201,
    handler: async ({ access, principal, body, meta }) => {
      const amount = parseAmount(body.amount, ASSETS[body.asset].decimals);
      const metadataSize = body.metadata ? JSON.stringify(body.metadata).length : 0;
      if (metadataSize > 2048) throw AppError.validation('metadata must be under 2 KB.');
      // Repeating a request with the same externalId returns the original invoice.
      const { invoice } = await createInvoice(
        ctx.db,
        {
          organizationId: orgIdOf(access),
          actor: callerOf(principal),
          assetId: body.asset,
          amount,
          network: ctx.config.network,
          enabledAssets: ctx.config.enabledAssets,
          ...(body.walletId ? { walletId: body.walletId } : {}),
          ...(body.externalId ? { externalId: body.externalId } : {}),
          ...(body.description ? { description: body.description } : {}),
          ...(body.metadata ? { metadata: body.metadata } : {}),
          ...(body.expiresInMinutes !== undefined
            ? { expiresInMinutes: body.expiresInMinutes }
            : {}),
        },
        meta,
      );
      return toInvoice(invoice);
    },
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/invoices',
    summary: 'List invoices (newest first)',
    tags: ['invoices'],
    auth: 'session_or_api_key',
    org: 'invoice:read',
    params: orgParams,
    query: pageQuery.extend({
      status: invoiceStatusSchema.optional(),
      externalId: z.string().max(200).optional(),
    }),
    response: z.object({ data: z.array(invoiceSchema), nextCursor: z.string().nullable() }),
    handler: async ({ access, query }) => {
      const before = cursorOf(query.cursor);
      const rows = await listInvoices(ctx.db, {
        organizationId: orgIdOf(access),
        limit: query.limit + 1,
        ...(query.status ? { status: query.status } : {}),
        ...(query.externalId ? { externalId: query.externalId } : {}),
        ...(before ? { before } : {}),
      });
      return {
        data: rows.slice(0, query.limit).map(toInvoice),
        nextCursor: nextCursor(rows, query.limit),
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/invoices/:invoiceId',
    summary: 'Get an invoice with its payments',
    tags: ['invoices'],
    auth: 'session_or_api_key',
    org: 'invoice:read',
    params: invoiceParams,
    response: invoiceSchema.extend({ payments: z.array(paymentSchema) }),
    handler: async ({ access, params }) => {
      const organizationId = orgIdOf(access);
      const invoice = await getInvoice(ctx.db, organizationId, params.invoiceId);
      const payments = await listPayments(ctx.db, {
        organizationId,
        invoiceId: invoice.id,
        limit: 200,
      });
      return { ...toInvoice(invoice), payments: payments.map(toPayment) };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/organizations/:orgId/invoices/:invoiceId/cancel',
    summary: 'Cancel an invoice that has received nothing',
    tags: ['invoices'],
    auth: 'session_or_api_key',
    org: 'invoice:cancel',
    idempotency: 'optional',
    params: invoiceParams,
    response: invoiceSchema,
    successStatus: 200,
    handler: async ({ access, principal, params, meta }) =>
      toInvoice(
        await cancelInvoice(
          ctx.db,
          {
            organizationId: orgIdOf(access),
            invoiceId: params.invoiceId,
            actor: callerOf(principal),
          },
          meta,
        ),
      ),
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/payments',
    summary: 'List payments received (newest first)',
    tags: ['payments'],
    auth: 'session_or_api_key',
    org: 'payment:read',
    params: orgParams,
    query: pageQuery,
    response: z.object({ data: z.array(paymentSchema), nextCursor: z.string().nullable() }),
    handler: async ({ access, query }) => {
      const before = cursorOf(query.cursor);
      const rows = await listPayments(ctx.db, {
        organizationId: orgIdOf(access),
        limit: query.limit + 1,
        ...(before ? { before } : {}),
      });
      return {
        data: rows.slice(0, query.limit).map(toPayment),
        nextCursor: nextCursor(rows, query.limit),
      };
    },
  });

  // ----------------------------------------------------------- payment links
  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/organizations/:orgId/payment-links',
    summary: 'Create a fixed-price payment link',
    tags: ['payment-links'],
    auth: 'session',
    org: 'invoice:create',
    idempotency: 'optional',
    params: orgParams,
    body: z
      .object({
        asset: assetIdSchema,
        amount: z.string().min(1).max(80),
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2000).optional(),
        invoiceTtlMinutes: z.number().int().min(5).max(43_200).optional(),
        maxOpenInvoices: z.number().int().min(1).max(500).optional(),
      })
      .strict(),
    response: linkSchema,
    successStatus: 201,
    handler: async ({ access, principal, body, meta }) =>
      toLink(
        await createPaymentLink(
          ctx.db,
          {
            organizationId: orgIdOf(access),
            actor: { userId: sessionOf(principal).userId },
            assetId: body.asset,
            amount: parseAmount(body.amount, ASSETS[body.asset].decimals),
            title: body.title,
            ...(body.description ? { description: body.description } : {}),
            ...(body.invoiceTtlMinutes !== undefined
              ? { invoiceTtlMinutes: body.invoiceTtlMinutes }
              : {}),
            ...(body.maxOpenInvoices !== undefined
              ? { maxOpenInvoices: body.maxOpenInvoices }
              : {}),
            enabledAssets: ctx.config.enabledAssets,
          },
          meta,
        ),
      ),
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/payment-links',
    summary: 'List payment links',
    tags: ['payment-links'],
    auth: 'session',
    org: 'invoice:read',
    params: orgParams,
    response: z.object({ data: z.array(linkSchema) }),
    handler: async ({ access }) => ({
      data: (await listPaymentLinks(ctx.db, orgIdOf(access))).map(toLink),
    }),
  });

  for (const active of [true, false] as const) {
    defineRoute(app, ctx, {
      method: 'POST',
      url: `/v1/organizations/:orgId/payment-links/:linkId/${active ? 'activate' : 'deactivate'}`,
      summary: `${active ? 'Re-enable' : 'Disable'} a payment link`,
      tags: ['payment-links'],
      auth: 'session',
      org: 'invoice:create',
      idempotency: 'optional',
      params: linkParams,
      response: linkSchema,
      successStatus: 200,
      handler: async ({ access, principal, params, meta }) =>
        toLink(
          await setPaymentLinkActive(
            ctx.db,
            {
              organizationId: orgIdOf(access),
              linkId: params.linkId,
              active,
              actor: { userId: sessionOf(principal).userId },
            },
            meta,
          ),
        ),
    });
  }

  // ------------------------------------------------------------------ public
  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/public/invoices/:publicId',
    summary: 'Hosted invoice view for the payer (no login)',
    tags: ['public'],
    auth: 'public',
    params: publicParams,
    response: z.object({
      publicId: z.string(),
      merchant: z.string(),
      status: invoiceStatusSchema,
      description: z.string().nullable(),
      amountDue: money,
      amountConfirmed: money,
      amountPending: money,
      deposit: z.object({
        chain: z.string(),
        network: z.string(),
        address: z.string(),
        destinationTag: z.number().nullable(),
        paymentUri: z.string().nullable(),
      }),
      expiresAt: isoDate,
    }),
    handler: async ({ params }) => {
      const invoice = await getInvoiceByPublicId(ctx.db, params.publicId);
      const org = await ctx.db
        .selectFrom('organizations')
        .select('name')
        .where('id', '=', invoice.organization_id)
        .executeTakeFirstOrThrow();
      const due = BigInt(invoice.amount_due);
      return {
        publicId: invoice.public_id,
        merchant: org.name,
        status: invoice.status,
        description: invoice.description,
        amountDue: moneyView(invoice.asset_id, due),
        amountConfirmed: moneyView(invoice.asset_id, BigInt(invoice.amount_confirmed)),
        amountPending: moneyView(invoice.asset_id, BigInt(invoice.amount_pending)),
        deposit: {
          chain: ASSETS[invoice.asset_id as AssetId].chain,
          network: ctx.config.network,
          address: invoice.address,
          destinationTag: invoice.destination_tag === null ? null : Number(invoice.destination_tag),
          paymentUri: paymentUri({
            assetId: invoice.asset_id,
            address: invoice.address,
            amount: due,
          }),
        },
        expiresAt: invoice.expires_at,
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/public/payment-links/:publicId',
    summary: 'Payment link details for the payer (no login)',
    tags: ['public'],
    auth: 'public',
    params: publicParams,
    response: z.object({
      merchant: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      amount: money,
    }),
    handler: async ({ params }) => {
      const link = await getPaymentLinkByPublicId(ctx.db, params.publicId);
      if (!link.active || link.organization_status !== 'active')
        throw AppError.notFound('Payment link');
      return {
        merchant: link.organization_name,
        title: link.title,
        description: link.description,
        amount: moneyView(link.asset_id, BigInt(link.amount)),
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/public/payment-links/:publicId/invoices',
    summary: 'Start a payment from a payment link (no login; strictly rate limited)',
    tags: ['public'],
    auth: 'public',
    rateLimit: 'auth',
    params: publicParams,
    response: z.object({ publicId: z.string(), hostedUrl: z.string() }),
    successStatus: 201,
    handler: async ({ params, meta }) => {
      const invoice = await createInvoiceFromLink(
        ctx.db,
        {
          publicId: params.publicId,
          network: ctx.config.network,
          enabledAssets: ctx.config.enabledAssets,
        },
        meta,
      );
      return { publicId: invoice.public_id, hostedUrl: hostedUrl(invoice.public_id) };
    },
  });
}
