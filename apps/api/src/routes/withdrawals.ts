/**
 * Withdrawals, destinations and limit policies (platform custody mode only).
 *
 * Who may do what:
 *   request a withdrawal   finance/admin/owner, or an API key with `withdrawal:create`
 *   approve                owner/admin only, a DIFFERENT person than the requester,
 *                          signed in with two-factor authentication
 *   add a destination      owner/admin, with two-factor authentication (cool-down applies)
 *   set limits             owner/admin, with two-factor authentication (increases are delayed)
 *
 * Nothing a request, approval or API key can do makes money move on its own:
 * the signer (a separate process) re-verifies everything before it signs.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OrgAccess, SessionPrincipal } from '@actualpay/auth';
import {
  AppError,
  ASSET_IDS,
  ASSETS,
  CHAIN_FAMILIES,
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  encodeCursor,
  MAX_PAGE_SIZE,
  parseAmount,
  type AssetId,
} from '@actualpay/shared';
import { moneyView } from '@actualpay/payments';
import type {
  WithdrawalDestinationRow,
  WithdrawalPolicyRow,
  WithdrawalRow,
} from '@actualpay/database';
import {
  addDestination,
  approveWithdrawal,
  assertPlatformCustody,
  cancelWithdrawal,
  getWithdrawal,
  listDestinations,
  listPolicies,
  listWithdrawals,
  rejectWithdrawal,
  requestWithdrawal,
  revokeDestination,
  setPolicy,
  WITHDRAWABLE_ASSETS,
  type WithdrawalConfig,
} from '@actualpay/withdrawals';
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

function requesterOf(principal: Principal | null): { type: 'user' | 'api_key'; id: string } {
  if (!principal) throw AppError.unauthenticated();
  const actor = auditActor(principal);
  if (actor.type === 'system') throw AppError.unauthenticated();
  return actor;
}

const money = z.object({ asset: z.string(), amount: z.string(), baseUnits: z.string() });
const statusSchema = z.enum([
  'pending_approval',
  'approved',
  'rejected',
  'cancelled',
  'expired',
  'signed',
  'broadcast',
  'confirmed',
  'failed',
  'needs_review',
]);
const withdrawalParams = z.object({ orgId: uuid, withdrawalId: uuid });
const destinationParams = z.object({ orgId: uuid, destinationId: uuid });
const assetEnum = z.enum(ASSET_IDS);

const withdrawalSchema = z.object({
  id: z.string(),
  status: statusSchema,
  amount: money,
  feeCharged: money,
  destination: z.object({ id: z.string(), address: z.string() }),
  clientRef: z.string().nullable(),
  description: z.string().nullable(),
  requestedBy: z.object({ type: z.enum(['user', 'api_key']), id: z.string() }),
  approvedBy: z.string().nullable(),
  approvedAt: nullableIsoDate,
  approvalExpiresAt: nullableIsoDate,
  txid: z.string().nullable(),
  confirmations: z.string(),
  networkFee: money.nullable(),
  decisionReason: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: isoDate,
  confirmedAt: nullableIsoDate,
});

const destinationSchema = z.object({
  id: z.string(),
  chain: z.enum(CHAIN_FAMILIES),
  address: z.string(),
  label: z.string(),
  createdAt: isoDate,
  activeAt: isoDate,
  /** False while the cool-down runs. */
  usable: z.boolean(),
  revokedAt: nullableIsoDate,
});

const policySchema = z.object({
  id: z.string(),
  asset: z.string(),
  enabled: z.boolean(),
  minAmount: money,
  maxPerWithdrawal: money,
  maxPerDay: money,
  effectiveAt: isoDate,
  /** False for a loosening that is still waiting out its delay. */
  inEffect: z.boolean(),
  createdAt: isoDate,
});

export function registerWithdrawalRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const tags = ['withdrawals'];
  const config = (): WithdrawalConfig => ({
    custodyMode: ctx.config.custody.mode,
    feeBps: ctx.config.custody.feeBps,
    enabledAssets: ctx.config.enabledAssets,
    network: ctx.config.network,
  });

  const toWithdrawal = (w: WithdrawalRow) => ({
    id: w.id,
    status: w.status,
    amount: moneyView(w.asset_id, BigInt(w.amount)),
    feeCharged: moneyView(w.asset_id, BigInt(w.fee_charged)),
    destination: { id: w.destination_id, address: w.destination_address },
    clientRef: w.client_ref,
    description: w.description,
    requestedBy: { type: w.requested_by_type, id: w.requested_by_id },
    approvedBy: w.approved_by,
    approvedAt: w.approved_at,
    approvalExpiresAt: w.approval_expires_at,
    txid: w.txid,
    confirmations: w.confirmations,
    networkFee:
      w.final_network_fee === null
        ? null
        : moneyView(ASSETS[w.asset_id as AssetId].feeAssetId, BigInt(w.final_network_fee)),
    decisionReason: w.decision_reason,
    lastError: w.last_error,
    createdAt: w.created_at,
    confirmedAt: w.confirmed_at,
  });

  const toDestination = (d: WithdrawalDestinationRow) => ({
    id: d.id,
    chain: d.chain,
    address: d.address,
    label: d.label,
    createdAt: d.created_at,
    activeAt: d.active_at,
    usable: d.revoked_at === null && d.active_at.getTime() <= Date.now(),
    revokedAt: d.revoked_at,
  });

  const toPolicy = (p: WithdrawalPolicyRow) => ({
    id: p.id,
    asset: p.asset_id,
    enabled: p.enabled,
    minAmount: moneyView(p.asset_id, BigInt(p.min_amount)),
    maxPerWithdrawal: moneyView(p.asset_id, BigInt(p.max_per_withdrawal)),
    maxPerDay: moneyView(p.asset_id, BigInt(p.max_per_day)),
    effectiveAt: p.effective_at,
    inEffect: p.effective_at.getTime() <= Date.now(),
    createdAt: p.created_at,
  });

  // ------------------------------------------------------------ withdrawals
  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/organizations/:orgId/withdrawals',
    summary: 'Request a withdrawal (funds are held at once; a second person must approve)',
    tags,
    auth: 'session_or_api_key',
    org: 'withdrawal:create',
    idempotency: 'optional',
    params: orgParams,
    body: z
      .object({
        asset: assetEnum,
        amount: z.string().min(1).max(80),
        destinationId: uuid,
        clientRef: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(500).optional(),
      })
      .strict(),
    response: withdrawalSchema,
    successStatus: 201,
    handler: async ({ access, principal, body, meta }) => {
      const { withdrawal } = await requestWithdrawal(
        ctx.db,
        {
          organizationId: orgIdOf(access),
          requester: requesterOf(principal),
          assetId: body.asset,
          amount: parseAmount(body.amount, ASSETS[body.asset].decimals),
          destinationId: body.destinationId,
          ...(body.clientRef ? { clientRef: body.clientRef } : {}),
          ...(body.description ? { description: body.description } : {}),
          config: config(),
        },
        meta,
      );
      return toWithdrawal(withdrawal);
    },
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/withdrawals',
    summary: 'List withdrawals (newest first)',
    tags,
    auth: 'session_or_api_key',
    org: 'withdrawal:read',
    params: orgParams,
    query: z.object({
      limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
      cursor: z.string().max(500).optional(),
      status: statusSchema.optional(),
    }),
    response: z.object({ data: z.array(withdrawalSchema), nextCursor: z.string().nullable() }),
    handler: async ({ access, query }) => {
      const before = query.cursor ? decodeCursor(query.cursor, ['createdAt', 'id']) : undefined;
      const rows = await listWithdrawals(ctx.db, {
        organizationId: orgIdOf(access),
        limit: query.limit + 1,
        ...(query.status ? { status: query.status } : {}),
        ...(before ? { before } : {}),
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        data: page.map(toWithdrawal),
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id })
            : null,
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/withdrawals/:withdrawalId',
    summary: 'Get a withdrawal',
    tags,
    auth: 'session_or_api_key',
    org: 'withdrawal:read',
    params: withdrawalParams,
    response: withdrawalSchema,
    handler: async ({ access, params }) =>
      toWithdrawal(await getWithdrawal(ctx.db, orgIdOf(access), params.withdrawalId)),
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/organizations/:orgId/withdrawals/:withdrawalId/approve',
    summary: 'Approve a withdrawal (not your own; needs two-factor authentication)',
    tags,
    auth: 'session',
    org: 'withdrawal:approve',
    requireMfa: true,
    idempotency: 'optional',
    params: withdrawalParams,
    response: withdrawalSchema,
    successStatus: 200,
    handler: async ({ access, principal, params, meta }) => {
      assertPlatformCustody(config());
      return toWithdrawal(
        await approveWithdrawal(
          ctx.db,
          {
            organizationId: orgIdOf(access),
            withdrawalId: params.withdrawalId,
            approverUserId: sessionOf(principal).userId,
            sealKey: ctx.config.custody.sealKey,
            approvalTtlMinutes: ctx.config.custody.approvalTtlMinutes,
          },
          meta,
        ),
      );
    },
  });

  const reasonBody = z.object({ reason: z.string().trim().max(500).optional() }).strict();
  for (const action of ['reject', 'cancel'] as const) {
    defineRoute(app, ctx, {
      method: 'POST',
      url: `/v1/organizations/:orgId/withdrawals/:withdrawalId/${action}`,
      summary:
        action === 'reject'
          ? 'Reject a withdrawal before it is signed (returns the held funds)'
          : 'Cancel your withdrawal before it is signed (returns the held funds)',
      tags,
      auth: 'session',
      org: action === 'reject' ? 'withdrawal:approve' : 'withdrawal:create',
      idempotency: 'optional',
      params: withdrawalParams,
      body: reasonBody,
      response: withdrawalSchema,
      successStatus: 200,
      handler: async ({ access, principal, params, body, meta }) => {
        const fn = action === 'reject' ? rejectWithdrawal : cancelWithdrawal;
        return toWithdrawal(
          await fn(
            ctx.db,
            {
              organizationId: orgIdOf(access),
              withdrawalId: params.withdrawalId,
              userId: sessionOf(principal).userId,
              ...(body.reason ? { reason: body.reason } : {}),
            },
            meta,
          ),
        );
      },
    });
  }

  // ----------------------------------------------------------- destinations
  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/organizations/:orgId/withdrawal-destinations',
    summary: 'Add a withdrawal destination (usable only after the cool-down)',
    tags,
    auth: 'session',
    org: 'settings:manage',
    requireMfa: true,
    idempotency: 'optional',
    params: orgParams,
    body: z
      .object({
        chain: z.enum(CHAIN_FAMILIES),
        address: z.string().trim().min(20).max(100),
        label: z.string().trim().min(1).max(100),
      })
      .strict(),
    response: destinationSchema,
    successStatus: 201,
    handler: async ({ access, principal, body, meta }) => {
      assertPlatformCustody(config());
      return toDestination(
        await addDestination(
          ctx.db,
          {
            organizationId: orgIdOf(access),
            userId: sessionOf(principal).userId,
            chain: body.chain,
            address: body.address,
            label: body.label,
            network: ctx.config.network,
            cooldownHours: ctx.config.custody.destinationCooldownHours,
          },
          meta,
        ),
      );
    },
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/withdrawal-destinations',
    summary: 'List withdrawal destinations',
    tags,
    auth: 'session_or_api_key',
    org: 'withdrawal:read',
    params: orgParams,
    response: z.object({ data: z.array(destinationSchema), assets: z.array(z.string()) }),
    handler: async ({ access }) => ({
      data: (await listDestinations(ctx.db, orgIdOf(access))).map(toDestination),
      assets: [...WITHDRAWABLE_ASSETS],
    }),
  });

  defineRoute(app, ctx, {
    method: 'POST',
    url: '/v1/organizations/:orgId/withdrawal-destinations/:destinationId/revoke',
    summary: 'Revoke a withdrawal destination',
    tags,
    auth: 'session',
    org: 'settings:manage',
    idempotency: 'optional',
    params: destinationParams,
    response: destinationSchema,
    successStatus: 200,
    handler: async ({ access, principal, params, meta }) =>
      toDestination(
        await revokeDestination(
          ctx.db,
          {
            organizationId: orgIdOf(access),
            destinationId: params.destinationId,
            userId: sessionOf(principal).userId,
          },
          meta,
        ),
      ),
  });

  // --------------------------------------------------------------- policies
  defineRoute(app, ctx, {
    method: 'PUT',
    url: '/v1/organizations/:orgId/withdrawal-policies/:asset',
    summary: 'Set withdrawal limits for an asset (loosening takes effect after a delay)',
    tags,
    auth: 'session',
    org: 'settings:manage',
    requireMfa: true,
    params: z.object({ orgId: uuid, asset: assetEnum }),
    body: z
      .object({
        enabled: z.boolean(),
        minAmount: z.string().min(1).max(80),
        maxPerWithdrawal: z.string().min(1).max(80),
        maxPerDay: z.string().min(1).max(80),
      })
      .strict(),
    response: policySchema,
    successStatus: 200,
    handler: async ({ access, principal, params, body, meta }) => {
      assertPlatformCustody(config());
      const decimals = ASSETS[params.asset].decimals;
      return toPolicy(
        await setPolicy(
          ctx.db,
          {
            organizationId: orgIdOf(access),
            assetId: params.asset,
            userId: sessionOf(principal).userId,
            enabled: body.enabled,
            minAmount: parseAmount(body.minAmount, decimals, { allowZero: true }),
            maxPerWithdrawal: parseAmount(body.maxPerWithdrawal, decimals, {
              allowZero: !body.enabled,
            }),
            maxPerDay: parseAmount(body.maxPerDay, decimals, { allowZero: !body.enabled }),
            increaseDelayHours: ctx.config.custody.policyIncreaseDelayHours,
          },
          meta,
        ),
      );
    },
  });

  defineRoute(app, ctx, {
    method: 'GET',
    url: '/v1/organizations/:orgId/withdrawal-policies',
    summary: 'List withdrawal limit versions (newest first)',
    tags,
    auth: 'session_or_api_key',
    org: 'withdrawal:read',
    params: orgParams,
    response: z.object({ data: z.array(policySchema) }),
    handler: async ({ access }) => ({
      data: (await listPolicies(ctx.db, orgIdOf(access))).map(toPolicy),
    }),
  });
}
