/**
 * Invoices: creation, cancellation, expiry and the status refresh that every
 * payment event runs through.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  asPgError,
  inTransaction,
  PG_ERRORS,
  type Db,
  type InvoiceRow,
  type Tx,
} from '@actualpay/database';
import { recordAudit, type RequestMeta } from '@actualpay/audit';
import { allocateDepositAddress } from '@actualpay/wallets';
import {
  AppError,
  ASSETS,
  assertPositive,
  formatAmount,
  MAX_BASE_UNITS,
  type AssetId,
  type NetworkMode,
} from '@actualpay/shared';
import { recordEvent, type EventType } from './events';
import { deriveInvoiceStatus, LIVE_STATUSES } from './status';

export const DEFAULT_INVOICE_TTL_MINUTES = 60;
export const MIN_INVOICE_TTL_MINUTES = 5;
export const MAX_INVOICE_TTL_MINUTES = 43_200; // 30 days
/** Every invoice permanently uses one address, so unpaid ones are capped. */
export const MAX_LIVE_INVOICES_PER_ORG = 5_000;

export type InvoiceActor =
  | { readonly type: 'user'; readonly id: string }
  | { readonly type: 'api_key'; readonly id: string }
  | { readonly type: 'payment_link'; readonly id: string };

export interface InvoiceView extends InvoiceRow {
  readonly address: string;
  readonly destination_tag: string | null;
}

export function newPublicId(): string {
  return randomBytes(24).toString('base64url'); // 192 bits, 32 chars
}

export function moneyView(assetId: string, baseUnits: bigint) {
  const asset = ASSETS[assetId as AssetId];
  return {
    asset: assetId,
    amount: formatAmount(baseUnits, asset.decimals),
    baseUnits: baseUnits.toString(),
  };
}

/** A payment URI wallets understand, where a reliable standard exists. */
export function paymentUri(params: {
  assetId: string;
  address: string;
  amount: bigint;
}): string | null {
  const asset = ASSETS[params.assetId as AssetId];
  switch (params.assetId) {
    case 'btc':
      return `bitcoin:${params.address}?amount=${formatAmount(params.amount, asset.decimals)}`;
    case 'ltc':
      return `litecoin:${params.address}?amount=${formatAmount(params.amount, asset.decimals)}`;
    case 'eth':
      return `ethereum:${params.address}?value=${params.amount.toString()}`;
    default:
      return null; // tokens, TRX and XRP have no URI we can rely on
  }
}

const eventForStatus: Partial<Record<InvoiceRow['status'], EventType>> = {
  processing: 'invoice.processing',
  partially_paid: 'invoice.partially_paid',
  paid: 'invoice.paid',
  expired: 'invoice.expired',
  cancelled: 'invoice.cancelled',
};

export function invoiceEventPayload(invoice: InvoiceRow): Record<string, unknown> {
  return {
    invoiceId: invoice.id,
    publicId: invoice.public_id,
    externalId: invoice.external_id,
    status: invoice.status,
    amountDue: moneyView(invoice.asset_id, BigInt(invoice.amount_due)),
    amountConfirmed: moneyView(invoice.asset_id, BigInt(invoice.amount_confirmed)),
    amountPending: moneyView(invoice.asset_id, BigInt(invoice.amount_pending)),
    paidLate: invoice.paid_late,
    expiresAt: invoice.expires_at.toISOString(),
  };
}

/**
 * Recompute an invoice's cached totals and status from its payments.
 * Locks the invoice row; call it after changing any of its payments.
 */
export async function refreshInvoice(
  tx: Tx,
  invoiceId: string,
  now: Date = new Date(),
): Promise<InvoiceRow> {
  const invoice = await tx
    .selectFrom('invoices')
    .selectAll()
    .where('id', '=', invoiceId)
    .forUpdate()
    .executeTakeFirst();
  if (!invoice) throw AppError.notFound('Invoice');

  const sums = await tx
    .selectFrom('payments')
    .select([
      sql<string>`COALESCE(SUM(amount) FILTER (WHERE status = 'confirmed'), 0)`.as('confirmed'),
      sql<string>`COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0)`.as('pending'),
    ])
    .where('invoice_id', '=', invoiceId)
    .where('counts_toward_invoice', '=', true)
    .executeTakeFirstOrThrow();
  const confirmed = BigInt(sums.confirmed);
  const pending = BigInt(sums.pending);
  const status = deriveInvoiceStatus({
    amountDue: BigInt(invoice.amount_due),
    confirmed,
    pending,
    expiresAt: invoice.expires_at,
    cancelledAt: invoice.cancelled_at,
    now,
  });

  const becamePaid = status === 'paid' && invoice.status !== 'paid';
  const leftPaid = status !== 'paid' && invoice.status === 'paid';
  const changed =
    status !== invoice.status ||
    confirmed !== BigInt(invoice.amount_confirmed) ||
    pending !== BigInt(invoice.amount_pending);
  if (!changed) return invoice;

  const updated = await tx
    .updateTable('invoices')
    .set({
      status,
      amount_confirmed: confirmed,
      amount_pending: pending,
      ...(becamePaid
        ? { paid_at: now, paid_late: now.getTime() >= invoice.expires_at.getTime() }
        : {}),
      ...(leftPaid ? { paid_at: null, paid_late: false } : {}),
    })
    .where('id', '=', invoiceId)
    .returningAll()
    .executeTakeFirstOrThrow();

  if (status !== invoice.status) {
    const type = leftPaid ? 'invoice.reopened' : eventForStatus[status];
    if (type) {
      await recordEvent(tx, {
        organizationId: invoice.organization_id,
        type,
        subjectType: 'invoice',
        subjectId: invoice.id,
        payload: invoiceEventPayload(updated),
      });
    }
  }
  return updated;
}

export interface CreateInvoiceParams {
  readonly organizationId: string;
  readonly actor: InvoiceActor;
  readonly assetId: AssetId;
  /** Base units. */
  readonly amount: bigint;
  readonly network: NetworkMode;
  readonly enabledAssets: readonly AssetId[];
  /** Required when the organization has more than one confirmed wallet for the chain. */
  readonly walletId?: string;
  readonly externalId?: string;
  readonly description?: string;
  readonly metadata?: Record<string, unknown>;
  readonly expiresInMinutes?: number;
  readonly paymentLinkId?: string;
  readonly now?: Date;
}

async function selectWallet(
  tx: Tx,
  params: { organizationId: string; chain: string; network: string; walletId?: string },
): Promise<string> {
  let query = tx
    .selectFrom('wallets')
    .select('id')
    .where('organization_id', '=', params.organizationId)
    .where('chain', '=', params.chain as 'bitcoin')
    .where('network', '=', params.network as 'mainnet')
    .where('status', '=', 'active')
    .where('verified_at', 'is not', null);
  if (params.walletId) query = query.where('id', '=', params.walletId);
  const wallets = await query.limit(2).execute();
  if (wallets.length === 0) {
    throw AppError.validation(
      params.walletId
        ? 'That wallet does not exist, is archived, or has not been confirmed.'
        : `No confirmed ${params.chain} wallet is available. Register and confirm one first.`,
    );
  }
  if (wallets.length > 1) {
    throw AppError.validation(
      `More than one confirmed ${params.chain} wallet exists; specify walletId.`,
    );
  }
  const [first] = wallets;
  if (!first) throw AppError.validation('No wallet available.');
  return first.id;
}

export async function createInvoiceTx(tx: Tx, params: CreateInvoiceParams, meta: RequestMeta) {
  const now = params.now ?? new Date();
  const asset = ASSETS[params.assetId];
  if (!params.enabledAssets.includes(params.assetId))
    throw AppError.validation(`${params.assetId} is not enabled in this deployment.`);
  assertPositive(params.amount, 'Invoice amount');
  if (params.amount > MAX_BASE_UNITS) throw AppError.validation('Amount is too large.');
  const ttl = params.expiresInMinutes ?? DEFAULT_INVOICE_TTL_MINUTES;
  if (!Number.isInteger(ttl) || ttl < MIN_INVOICE_TTL_MINUTES || ttl > MAX_INVOICE_TTL_MINUTES)
    throw AppError.validation(
      `expiresInMinutes must be between ${MIN_INVOICE_TTL_MINUTES} and ${MAX_INVOICE_TTL_MINUTES}.`,
    );

  // Never hand out an address that nothing is watching: a watcher must have
  // started scanning this chain before the first invoice exists.
  const cursor = await tx
    .selectFrom('chain_cursors')
    .select('chain')
    .where('chain', '=', asset.chain)
    .where('network', '=', params.network)
    .executeTakeFirst();
  if (!cursor) {
    throw new AppError(
      'UPSTREAM_UNAVAILABLE',
      `Payment watching for ${asset.chain} has not started yet. Make sure the worker is running.`,
    );
  }

  const walletId = await selectWallet(tx, {
    organizationId: params.organizationId,
    chain: asset.chain,
    network: params.network,
    ...(params.walletId ? { walletId: params.walletId } : {}),
  });

  // Taking the wallet's row lock (inside allocateDepositAddress) serializes
  // invoice creation per wallet, which also makes the cap below reliable.
  const invoiceId = randomUUID();
  const deposit = await allocateDepositAddress(tx, {
    organizationId: params.organizationId,
    walletId,
    reference: { type: 'invoice', id: invoiceId },
  });

  const live = await tx
    .selectFrom('invoices')
    .select(sql<string>`count(*)`.as('n'))
    .where('organization_id', '=', params.organizationId)
    .where('status', 'in', [...LIVE_STATUSES])
    .where('expires_at', '>', now)
    .executeTakeFirstOrThrow();
  if (Number(live.n) >= MAX_LIVE_INVOICES_PER_ORG)
    throw new AppError(
      'RATE_LIMITED',
      'Too many unpaid invoices are open. Wait for some to expire.',
    );

  const inserted = await tx
    .insertInto('invoices')
    .values({
      id: invoiceId,
      public_id: newPublicId(),
      organization_id: params.organizationId,
      wallet_id: walletId,
      deposit_address_id: deposit.id,
      payment_link_id: params.paymentLinkId ?? null,
      asset_id: params.assetId,
      amount_due: params.amount,
      external_id: params.externalId ?? null,
      description: params.description ?? null,
      metadata: JSON.stringify(params.metadata ?? {}),
      expires_at: new Date(now.getTime() + ttl * 60_000),
      created_by_type: params.actor.type,
      created_by_id: params.actor.id,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordEvent(tx, {
    organizationId: params.organizationId,
    type: 'invoice.created',
    subjectType: 'invoice',
    subjectId: inserted.id,
    payload: {
      ...invoiceEventPayload(inserted),
      address: deposit.address,
      destinationTag: deposit.destination_tag,
    },
  });
  if (params.actor.type !== 'payment_link') {
    await recordAudit(tx, {
      actor: params.actor,
      action: 'invoice.created',
      organizationId: params.organizationId,
      target: { type: 'invoice', id: inserted.id },
      meta,
      metadata: { assetId: params.assetId, amount: params.amount.toString() },
    });
  }
  return { ...inserted, address: deposit.address, destination_tag: deposit.destination_tag };
}

/**
 * Create an invoice. When `externalId` is given the call is idempotent: the
 * same order id with the same asset and amount returns the original invoice;
 * the same order id with a different amount or asset is a conflict.
 */
export async function createInvoice(
  db: Db,
  params: CreateInvoiceParams,
  meta: RequestMeta,
): Promise<{ invoice: InvoiceView; created: boolean }> {
  const existing = async (): Promise<InvoiceView | null> => {
    if (!params.externalId) return null;
    const found = await getInvoiceByExternalId(db, params.organizationId, params.externalId);
    if (!found) return null;
    if (found.asset_id !== params.assetId || BigInt(found.amount_due) !== params.amount)
      throw AppError.conflict(
        'An invoice with this externalId already exists with different terms.',
      );
    return found;
  };
  const prior = await existing();
  if (prior) return { invoice: prior, created: false };
  try {
    const invoice = await inTransaction(db, (tx) => createInvoiceTx(tx, params, meta));
    return { invoice, created: true };
  } catch (error) {
    if (asPgError(error)?.code === PG_ERRORS.UNIQUE_VIOLATION && params.externalId) {
      const raced = await existing();
      if (raced) return { invoice: raced, created: false };
    }
    throw error;
  }
}

const viewColumns = [
  'invoices.id',
  'invoices.public_id',
  'invoices.organization_id',
  'invoices.wallet_id',
  'invoices.deposit_address_id',
  'invoices.payment_link_id',
  'invoices.asset_id',
  'invoices.amount_due',
  'invoices.amount_confirmed',
  'invoices.amount_pending',
  'invoices.status',
  'invoices.external_id',
  'invoices.description',
  'invoices.metadata',
  'invoices.expires_at',
  'invoices.cancelled_at',
  'invoices.paid_at',
  'invoices.paid_late',
  'invoices.created_by_type',
  'invoices.created_by_id',
  'invoices.created_at',
  'invoices.updated_at',
  'deposit_addresses.address',
  'deposit_addresses.destination_tag',
] as const;

function viewQuery(db: Db | Tx) {
  return db
    .selectFrom('invoices')
    .innerJoin('deposit_addresses', 'deposit_addresses.id', 'invoices.deposit_address_id')
    .select(viewColumns);
}

export async function getInvoice(
  db: Db | Tx,
  organizationId: string,
  invoiceId: string,
): Promise<InvoiceView> {
  const row = await viewQuery(db)
    .where('invoices.id', '=', invoiceId)
    .where('invoices.organization_id', '=', organizationId)
    .executeTakeFirst();
  if (!row) throw AppError.notFound('Invoice');
  return row;
}

export async function getInvoiceByExternalId(
  db: Db | Tx,
  organizationId: string,
  externalId: string,
): Promise<InvoiceView | null> {
  return (
    (await viewQuery(db)
      .where('invoices.organization_id', '=', organizationId)
      .where('invoices.external_id', '=', externalId)
      .executeTakeFirst()) ?? null
  );
}

/** Public lookup by the unguessable id; callers expose only a safe subset. */
export async function getInvoiceByPublicId(db: Db, publicId: string): Promise<InvoiceView> {
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(publicId)) throw AppError.notFound('Invoice');
  const row = await viewQuery(db).where('invoices.public_id', '=', publicId).executeTakeFirst();
  if (!row) throw AppError.notFound('Invoice');
  return row;
}

export async function listInvoices(
  db: Db,
  params: {
    organizationId: string;
    limit: number;
    status?: InvoiceRow['status'];
    externalId?: string;
    before?: { createdAt: string; id: string };
  },
): Promise<InvoiceView[]> {
  let query = viewQuery(db).where('invoices.organization_id', '=', params.organizationId);
  if (params.status) query = query.where('invoices.status', '=', params.status);
  if (params.externalId) query = query.where('invoices.external_id', '=', params.externalId);
  if (params.before) {
    const { createdAt, id } = params.before;
    query = query.where((eb) =>
      eb.or([
        eb('invoices.created_at', '<', new Date(createdAt)),
        eb.and([eb('invoices.created_at', '=', new Date(createdAt)), eb('invoices.id', '<', id)]),
      ]),
    );
  }
  return query
    .orderBy('invoices.created_at', 'desc')
    .orderBy('invoices.id', 'desc')
    .limit(params.limit)
    .execute();
}

/** Cancel an invoice that has received nothing. Idempotent. */
export async function cancelInvoice(
  db: Db,
  params: {
    organizationId: string;
    invoiceId: string;
    actor: InvoiceActor & { type: 'user' | 'api_key' };
  },
  meta: RequestMeta,
): Promise<InvoiceView> {
  await inTransaction(db, async (tx) => {
    const invoice = await tx
      .selectFrom('invoices')
      .selectAll()
      .where('id', '=', params.invoiceId)
      .where('organization_id', '=', params.organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!invoice) throw AppError.notFound('Invoice');
    if (invoice.status === 'cancelled') return;
    const anyPayment = await tx
      .selectFrom('payments')
      .select('id')
      .where('invoice_id', '=', invoice.id)
      .where('status', 'in', ['pending', 'confirmed'])
      .limit(1)
      .executeTakeFirst();
    if (invoice.status !== 'open' && invoice.status !== 'expired') {
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        `A ${invoice.status.replace('_', ' ')} invoice cannot be cancelled.`,
      );
    }
    if (anyPayment) {
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        'An invoice that has received a payment cannot be cancelled.',
      );
    }
    const now = new Date();
    const cancelled = await tx
      .updateTable('invoices')
      .set({ status: 'cancelled', cancelled_at: now })
      .where('id', '=', invoice.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordEvent(tx, {
      organizationId: params.organizationId,
      type: 'invoice.cancelled',
      subjectType: 'invoice',
      subjectId: invoice.id,
      payload: invoiceEventPayload(cancelled),
    });
    await recordAudit(tx, {
      actor: params.actor,
      action: 'invoice.cancelled',
      organizationId: params.organizationId,
      target: { type: 'invoice', id: invoice.id },
      meta,
    });
  });
  return getInvoice(db, params.organizationId, params.invoiceId);
}

/**
 * Move unpaid invoices whose time is up to `expired`. Safe to run from several
 * workers at once (rows are claimed with SKIP LOCKED) and safe to repeat.
 * Invoices with a payment in flight stay `processing` until it resolves.
 */
export async function expireInvoices(
  db: Db,
  options: { now?: Date; limit?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 200;
  return inTransaction(db, async (tx) => {
    const due = await tx
      .selectFrom('invoices')
      .select('id')
      .where('status', 'in', ['open', 'partially_paid'])
      .where('expires_at', '<=', now)
      .orderBy('expires_at')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();
    for (const row of due) await refreshInvoice(tx, row.id, now);
    return due.length;
  });
}
