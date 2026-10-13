/**
 * Wallet and deposit-address endpoints (watch-only).
 *
 * Registering, confirming or archiving a wallet decides where customers' money
 * goes, so those actions are session-only, restricted to wallet managers, and
 * require a session that passed two-factor authentication: a stolen password
 * alone must not be able to point invoices at an attacker's key. Reads are
 * available to API keys carrying `wallet:read`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  ASSETS,
  CHAIN_FAMILIES,
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  encodeCursor,
  MAX_PAGE_SIZE,
  type ChainFamily,
} from '@actualpay/shared';
import {
  archiveWallet,
  confirmWallet,
  createWallet,
  getWallet,
  listDepositAddresses,
  listWallets,
  type DepositAddressRow,
  type WalletRow,
} from '@actualpay/wallets';
import type { OrgAccess, SessionPrincipal } from '@actualpay/auth';
import type { ApiContext } from '../http/context';
import type { Principal } from '../http/principal';
import { defineRoute } from '../http/route';
import { isoDate, nullableIsoDate, orgParams, uuid } from './schemas';

function sessionOf(principal: Principal | null): SessionPrincipal {
  if (principal?.kind !== 'session') throw AppError.unauthenticated();
  return principal.session;
}

function orgIdOf(access: OrgAccess | null): string {
  if (!access) throw AppError.notFound('Organization');
  return access.organizationId;
}

const walletParams = z.object({ orgId: uuid, walletId: uuid });

const walletSchema = z.object({
  id: z.string(),
  chain: z.enum(CHAIN_FAMILIES),
  network: z.enum(['mainnet', 'testnet']),
  label: z.string(),
  /** The account-level PUBLIC key; absent for XRPL. */
  accountXpub: z.string().nullable(),
  xrplAddress: z.string().nullable(),
  status: z.enum(['active', 'archived']),
  /** Whether the first address has been confirmed against the operator's own wallet. */
  confirmed: z.boolean(),
  confirmedAt: nullableIsoDate,
  nextIndex: z.string(),
  createdAt: isoDate,
  archivedAt: nullableIsoDate,
});

const toWallet = (w: WalletRow) => ({
  id: w.id,
  chain: w.chain,
  network: w.network,
  label: w.label,
  accountXpub: w.account_xpub,
  xrplAddress: w.xrpl_address,
  status: w.status,
  confirmed: w.verified_at !== null,
  confirmedAt: w.verified_at,
  nextIndex: w.next_index,
  createdAt: w.created_at,
  archivedAt: w.archived_at,
});

const depositSchema = z.object({
  id: z.string(),
  walletId: z.string(),
  chain: z.enum(CHAIN_FAMILIES),
  address: z.string(),
  derivationIndex: z.string().nullable(),
  destinationTag: z.string().nullable(),
  referenceType: z.string().nullable(),
  referenceId: z.string().nullable(),
  createdAt: isoDate,
});

const toDeposit = (d: DepositAddressRow) => ({
  id: d.id,
  walletId: d.wallet_id,
  chain: d.chain,
  address: d.address,
  derivationIndex: d.derivation_index,
  destinationTag: d.destination_tag,
  referenceType: d.reference_type,
  referenceId: d.reference_id,
  createdAt: d.created_at,
});

export function registerWalletRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const tags = ['wallets'];
  const enabledChains = (): ChainFamily[] => [
    ...new Set(ctx.config.enabledAssets.map((id) => ASSETS[id].chain)),
  ];

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/organizations/:orgId/wallets',
    summary: 'Register a watch-only wallet (account-level public key, or an XRPL account)',
    tags,
    auth: 'session',
    org: 'wallet:manage',
    requireMfa: true,
    idempotency: 'optional',
    params: orgParams,
    body: z
      .object({
        chain: z.enum(CHAIN_FAMILIES),
        label: z.string().trim().min(1).max(100),
        accountXpub: z.string().trim().min(100).max(130).optional(),
        xrplAddress: z.string().trim().min(25).max(35).optional(),
      })
      .strict(),
    response: z.object({
      wallet: walletSchema,
      firstAddress: z.object({ address: z.string(), destinationTag: z.number().nullable() }),
      next: z.string(),
    }),
    successStatus: 201,
    handler: async ({ access, principal, body, meta }) => {
      const { wallet, firstAddress } = await createWallet(
        ctx.db,
        {
          organizationId: orgIdOf(access),
          actor: { type: 'user', id: sessionOf(principal).userId },
          chain: body.chain,
          network: ctx.config.network,
          enabledChains: enabledChains(),
          label: body.label,
          ...(body.accountXpub ? { accountXpub: body.accountXpub } : {}),
          ...(body.xrplAddress ? { xrplAddress: body.xrplAddress } : {}),
        },
        meta,
      );
      return {
        wallet: toWallet(wallet),
        firstAddress: {
          address: firstAddress.address,
          destinationTag: firstAddress.destinationTag ?? null,
        },
        next:
          'Compare this first address with the one your wallet software shows for the same ' +
          'account, then confirm it. No addresses are issued until you do.',
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/organizations/:orgId/wallets/:walletId/confirm',
    summary: 'Confirm the wallet by entering its first address as your own wallet shows it',
    tags,
    auth: 'session',
    org: 'wallet:manage',
    requireMfa: true,
    idempotency: 'optional',
    params: walletParams,
    body: z.object({ address: z.string().trim().min(20).max(100) }).strict(),
    response: walletSchema,
    successStatus: 200,
    handler: async ({ access, principal, params, body, meta }) =>
      toWallet(
        await confirmWallet(
          ctx.db,
          {
            organizationId: orgIdOf(access),
            walletId: params.walletId,
            actor: { type: 'user', id: sessionOf(principal).userId },
            address: body.address,
          },
          meta,
        ),
      ),
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/organizations/:orgId/wallets/:walletId/archive',
    summary: 'Archive a wallet (stops issuing addresses; old addresses are still watched)',
    tags,
    auth: 'session',
    org: 'wallet:manage',
    requireMfa: true,
    idempotency: 'optional',
    params: walletParams,
    response: walletSchema,
    successStatus: 200,
    handler: async ({ access, principal, params, meta }) =>
      toWallet(
        await archiveWallet(
          ctx.db,
          {
            organizationId: orgIdOf(access),
            walletId: params.walletId,
            actor: { type: 'user', id: sessionOf(principal).userId },
          },
          meta,
        ),
      ),
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/wallets',
    summary: 'List wallets',
    tags,
    auth: 'session_or_api_key',
    org: 'wallet:read',
    params: orgParams,
    response: z.object({ data: z.array(walletSchema) }),
    handler: async ({ access }) => ({
      data: (await listWallets(ctx.db, orgIdOf(access))).map(toWallet),
    }),
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/wallets/:walletId',
    summary: 'Get a wallet',
    tags,
    auth: 'session_or_api_key',
    org: 'wallet:read',
    params: walletParams,
    response: walletSchema,
    handler: async ({ access, params }) =>
      toWallet(await getWallet(ctx.db, orgIdOf(access), params.walletId)),
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/wallets/:walletId/addresses',
    summary: 'List issued deposit addresses (newest first, cursor-paginated)',
    tags,
    auth: 'session_or_api_key',
    org: 'wallet:read',
    params: walletParams,
    query: z.object({
      limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
      cursor: z.string().max(500).optional(),
    }),
    response: z.object({ data: z.array(depositSchema), nextCursor: z.string().nullable() }),
    handler: async ({ access, params, query }) => {
      const organizationId = orgIdOf(access);
      await getWallet(ctx.db, organizationId, params.walletId); // 404 for foreign wallets
      const before = query.cursor ? decodeCursor(query.cursor, ['createdAt', 'id']) : undefined;
      const rows = await listDepositAddresses(ctx.db, {
        organizationId,
        walletId: params.walletId,
        limit: query.limit + 1,
        ...(before ? { before } : {}),
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        data: page.map(toDeposit),
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id })
            : null,
      };
    },
  });
}
