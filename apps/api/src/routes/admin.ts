/**
 * Platform administrator endpoints.
 *
 * Only users flagged `is_platform_admin`, signed in with two-factor
 * authentication, may call these. They are the controls an operator needs:
 * registering platform-held wallets for organizations (custodial mode), the
 * hot-wallet registry that authorises the signer, the withdrawal pause switch,
 * recording funds added to the platform's holdings, and the reconciliation
 * issues list. Every action is audited.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SessionPrincipal } from '@actualpay/auth';
import { AppError, ASSET_IDS, ASSETS, CHAIN_FAMILIES, parseAmount } from '@actualpay/shared';
import {
  listHotWallets,
  recordPlatformFunding,
  registerHotWallet,
  retireHotWallet,
  setWithdrawalsPaused,
  withdrawalsPaused,
} from '@actualpay/withdrawals';
import { archiveWallet, confirmWallet, createWallet } from '@actualpay/wallets';
import { listIssues, resolveIssue } from '@actualpay/watcher';
import { moneyView } from '@actualpay/payments';
import type { ApiContext } from '../http/context';
import type { Principal } from '../http/principal';
import { defineRoute } from '../http/route';
import { isoDate, nullableIsoDate, uuid } from './schemas';
import { toWallet, walletSchema } from './wallets';

function adminOf(principal: Principal | null): SessionPrincipal {
  if (principal?.kind !== 'session') throw AppError.unauthenticated();
  if (!principal.session.isPlatformAdmin)
    throw AppError.forbidden('This action is for platform administrators.');
  return principal.session;
}

const orgOnly = z.object({ orgId: uuid });
const walletOnly = z.object({ orgId: uuid, walletId: uuid });

export function registerAdminRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const tags = ['admin'];
  const requirePlatformMode = (): void => {
    if (ctx.config.custody.mode !== 'platform')
      throw AppError.conflict(
        'Administrators register wallets only in platform custody mode. In merchant mode organizations register their own.',
      );
  };

  // ------------------------------------------------- platform-held wallets
  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/admin/organizations/:orgId/wallets',
    summary: 'Register a platform-held wallet for an organization (custodial mode)',
    tags,
    auth: 'session',
    requireMfa: true,
    params: orgOnly,
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
    }),
    successStatus: 201,
    handler: async ({ principal, params, body, meta }) => {
      const admin = adminOf(principal);
      requirePlatformMode();
      const org = await ctx.db
        .selectFrom('organizations')
        .select('id')
        .where('id', '=', params.orgId)
        .executeTakeFirst();
      if (!org) throw AppError.notFound('Organization');
      const { wallet, firstAddress } = await createWallet(
        ctx.db,
        {
          organizationId: params.orgId,
          actor: { type: 'user', id: admin.userId },
          chain: body.chain,
          network: ctx.config.network,
          enabledChains: [...new Set(ctx.config.enabledAssets.map((id) => ASSETS[id].chain))],
          label: body.label,
          ...(body.accountXpub ? { accountXpub: body.accountXpub } : {}),
          ...(body.xrplAddress ? { xrplAddress: body.xrplAddress } : {}),
          ...(body.chain === 'xrpl'
            ? { xrplWatchedAccount: ctx.config.chains.xrpl?.depositAccount ?? null }
            : {}),
        },
        meta,
      );
      return {
        wallet: toWallet(wallet),
        firstAddress: {
          address: firstAddress.address,
          destinationTag: firstAddress.destinationTag ?? null,
        },
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/admin/organizations/:orgId/wallets/:walletId/confirm',
    summary: 'Confirm a platform-held wallet against the operator wallet software',
    tags,
    auth: 'session',
    requireMfa: true,
    params: walletOnly,
    body: z.object({ address: z.string().trim().min(20).max(100) }).strict(),
    response: walletSchema,
    successStatus: 200,
    handler: async ({ principal, params, body, meta }) => {
      const admin = adminOf(principal);
      requirePlatformMode();
      return toWallet(
        await confirmWallet(
          ctx.db,
          {
            organizationId: params.orgId,
            walletId: params.walletId,
            actor: { type: 'user', id: admin.userId },
            address: body.address,
          },
          meta,
        ),
      );
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/admin/organizations/:orgId/wallets/:walletId/archive',
    summary: 'Archive a platform-held wallet',
    tags,
    auth: 'session',
    requireMfa: true,
    params: walletOnly,
    response: walletSchema,
    successStatus: 200,
    handler: async ({ principal, params, meta }) => {
      const admin = adminOf(principal);
      requirePlatformMode();
      return toWallet(
        await archiveWallet(
          ctx.db,
          {
            organizationId: params.orgId,
            walletId: params.walletId,
            actor: { type: 'user', id: admin.userId },
          },
          meta,
        ),
      );
    },
  });

  // ------------------------------------------------------- hot wallet registry
  const hotWalletSchema = z.object({
    id: z.string(),
    chain: z.enum(CHAIN_FAMILIES),
    network: z.string(),
    address: z.string(),
    label: z.string(),
    status: z.enum(['active', 'retired']),
    createdAt: isoDate,
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/admin/hot-wallets',
    summary: 'List registered hot wallets',
    tags,
    auth: 'session',
    requireMfa: true,
    response: z.object({ data: z.array(hotWalletSchema) }),
    handler: async ({ principal }) => {
      adminOf(principal);
      const rows = await listHotWallets(ctx.db);
      return {
        data: rows.map((h) => ({
          id: h.id,
          chain: h.chain,
          network: h.network,
          address: h.address,
          label: h.label,
          status: h.status,
          createdAt: h.created_at,
        })),
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/admin/hot-wallets',
    summary:
      'Authorise the signer to pay from a hot wallet (use the address `signer:init` printed)',
    tags,
    auth: 'session',
    requireMfa: true,
    body: z
      .object({
        chain: z.enum(CHAIN_FAMILIES),
        address: z.string().trim().min(20).max(100),
        label: z.string().trim().min(1).max(100),
      })
      .strict(),
    response: hotWalletSchema,
    successStatus: 201,
    handler: async ({ principal, body, meta }) => {
      const admin = adminOf(principal);
      requirePlatformMode();
      const h = await registerHotWallet(
        ctx.db,
        {
          chain: body.chain,
          network: ctx.config.network,
          address: body.address,
          label: body.label,
          userId: admin.userId,
        },
        meta,
      );
      return {
        id: h.id,
        chain: h.chain,
        network: h.network,
        address: h.address,
        label: h.label,
        status: h.status,
        createdAt: h.created_at,
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/admin/hot-wallets/:hotWalletId/retire',
    summary: 'Stop the signer paying from a hot wallet',
    tags,
    auth: 'session',
    requireMfa: true,
    params: z.object({ hotWalletId: uuid }),
    response: hotWalletSchema,
    successStatus: 200,
    handler: async ({ principal, params, meta }) => {
      const admin = adminOf(principal);
      const h = await retireHotWallet(
        ctx.db,
        { hotWalletId: params.hotWalletId, userId: admin.userId },
        meta,
      );
      return {
        id: h.id,
        chain: h.chain,
        network: h.network,
        address: h.address,
        label: h.label,
        status: h.status,
        createdAt: h.created_at,
      };
    },
  });

  // ------------------------------------------------------ pause / status
  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/admin/withdrawals/pause',
    summary: 'Emergency stop: no withdrawal can be requested, approved or signed',
    tags,
    auth: 'session',
    requireMfa: true,
    body: z.object({ reason: z.string().trim().min(3).max(500) }).strict(),
    response: z.object({ paused: z.boolean() }),
    successStatus: 200,
    handler: async ({ principal, body, meta }) => {
      const admin = adminOf(principal);
      await setWithdrawalsPaused(
        ctx.db,
        { paused: true, reason: body.reason, userId: admin.userId },
        meta,
      );
      return { paused: true };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/admin/withdrawals/resume',
    summary: 'Lift the withdrawal pause',
    tags,
    auth: 'session',
    requireMfa: true,
    response: z.object({ paused: z.boolean() }),
    successStatus: 200,
    handler: async ({ principal, meta }) => {
      const admin = adminOf(principal);
      await setWithdrawalsPaused(ctx.db, { paused: false, userId: admin.userId }, meta);
      return { paused: false };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/admin/status',
    summary: 'Platform status: custody mode, pause switch, watcher cursors, open issues',
    tags,
    auth: 'session',
    requireMfa: true,
    response: z.object({
      custodyMode: z.string(),
      network: z.string(),
      withdrawalsPaused: z.boolean(),
      pauseReason: z.string().nullable(),
      chains: z.array(
        z.object({
          chain: z.string(),
          scannedAt: nullableIsoDate,
          tipHeight: z.string().nullable(),
          synced: z.boolean().nullable(),
          lastError: z.string().nullable(),
        }),
      ),
      openIssues: z.object({ critical: z.number(), warning: z.number() }),
    }),
    handler: async ({ principal }) => {
      adminOf(principal);
      const paused = await withdrawalsPaused(ctx.db);
      const cursors = await ctx.db.selectFrom('chain_cursors').selectAll().execute();
      const issues = await listIssues(ctx.db, { status: 'open' });
      return {
        custodyMode: ctx.config.custody.mode,
        network: ctx.config.network,
        withdrawalsPaused: paused.paused,
        pauseReason: paused.reason,
        chains: cursors.map((c) => ({
          chain: c.chain,
          scannedAt: c.scanned_at,
          tipHeight: c.tip_height,
          synced: c.synced,
          lastError: c.last_error,
        })),
        openIssues: {
          critical: issues.filter((i) => i.severity === 'critical').length,
          warning: issues.filter((i) => i.severity === 'warning').length,
        },
      };
    },
  });

  // ---------------------------------------------------------------- funding
  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/admin/platform-funding',
    summary: 'Record coins you added to the platform holdings (e.g. ETH for gas)',
    tags,
    auth: 'session',
    requireMfa: true,
    body: z
      .object({
        asset: z.enum(ASSET_IDS),
        amount: z.string().min(1).max(80),
        reference: z.string().trim().min(3).max(100),
        note: z.string().trim().max(500).optional(),
      })
      .strict(),
    response: z.object({
      journalId: z.string(),
      created: z.boolean(),
      amount: z.object({ asset: z.string(), amount: z.string(), baseUnits: z.string() }),
    }),
    successStatus: 201,
    handler: async ({ principal, body, meta }) => {
      const admin = adminOf(principal);
      const amount = parseAmount(body.amount, ASSETS[body.asset].decimals);
      const posted = await recordPlatformFunding(
        ctx.db,
        {
          assetId: body.asset,
          amount,
          reference: body.reference,
          ...(body.note ? { note: body.note } : {}),
          userId: admin.userId,
        },
        meta,
      );
      return { ...posted, amount: moneyView(body.asset, amount) };
    },
  });

  // ----------------------------------------------------------------- issues
  const issueSchema = z.object({
    id: z.string(),
    kind: z.string(),
    severity: z.enum(['warning', 'critical']),
    status: z.enum(['open', 'resolved']),
    subjectType: z.string(),
    subjectId: z.string(),
    summary: z.string(),
    occurrences: z.number(),
    firstSeenAt: isoDate,
    lastSeenAt: isoDate,
    resolutionNote: z.string().nullable(),
  });
  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/admin/issues',
    summary: 'Reconciliation issues that need a human',
    tags,
    auth: 'session',
    requireMfa: true,
    query: z.object({ status: z.enum(['open', 'resolved']).default('open') }),
    response: z.object({ data: z.array(issueSchema) }),
    handler: async ({ principal, query }) => {
      adminOf(principal);
      const rows = await listIssues(ctx.db, { status: query.status });
      return {
        data: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          severity: r.severity,
          status: r.status,
          subjectType: r.subject_type,
          subjectId: r.subject_id,
          summary: r.summary,
          occurrences: r.occurrences,
          firstSeenAt: r.first_seen_at,
          lastSeenAt: r.last_seen_at,
          resolutionNote: r.resolution_note,
        })),
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/admin/issues/:issueId/resolve',
    summary: 'Resolve an issue with a note (audited)',
    tags,
    auth: 'session',
    requireMfa: true,
    params: z.object({ issueId: uuid }),
    body: z.object({ note: z.string().trim().min(3).max(2000) }).strict(),
    response: z.object({ id: z.string(), status: z.literal('resolved') }),
    successStatus: 200,
    handler: async ({ principal, params, body, meta }) => {
      const admin = adminOf(principal);
      const row = await resolveIssue(
        ctx.db,
        { issueId: params.issueId, userId: admin.userId, note: body.note },
        meta,
      );
      return { id: row.id, status: 'resolved' as const };
    },
  });
}
