/**
 * Route definition helper. Every endpoint is declared through `defineRoute`,
 * which enforces, in this order:
 *
 *   1. path parameter validation
 *   2. authentication (session cookie or API key, as the route allows)
 *   3. CSRF protection for cookie-authenticated state changes
 *   4. organization access: membership/key ownership, permission, suspension
 *   5. query and body validation (Zod)
 *   6. idempotency
 *   7. the handler, whose result is parsed through the response schema so
 *      fields not declared in the schema can never leak to clients
 *
 * Handlers therefore never see unauthenticated, unauthorized or unvalidated
 * input, and there is no way to declare a route that skips these steps.
 * Route metadata is also kept in a registry for OpenAPI generation (Phase 11).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodType, type ZodTypeDef } from 'zod';
import { AppError, isAppError } from '@actualpay/shared';
import {
  authenticateApiKey,
  sha256Hex,
  resolveMemberAccess,
  validateSession,
  verifyCsrfToken,
  type ApiKeyScope,
  type OrgAccess,
  type Permission,
} from '@actualpay/auth';
import type { RequestMeta } from '@actualpay/audit';
import type { ApiContext } from './context';
import { zodToAppError } from './errors';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  requestFingerprint,
  validateIdempotencyKey,
  type IdempotencyClaim,
} from './idempotency';
import { bearerToken, sessionCookieName, type Principal } from './principal';

export type AuthMode = 'public' | 'session' | 'session_or_api_key';
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
type Schema<T> = ZodType<T, ZodTypeDef, unknown>;

export interface RouteContext<B, Q, P> {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly body: B;
  readonly query: Q;
  readonly params: P;
  readonly meta: RequestMeta;
  readonly principal: Principal | null;
  /** Present when the route is organization-scoped. */
  readonly access: (OrgAccess & { readonly via: 'member' | 'api_key' }) | null;
}

export interface RouteDefinition<B, Q, P, R, RIn> {
  readonly method: HttpMethod;
  readonly url: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly auth: AuthMode;
  /**
   * Organization scoping. `true` = any valid access to `:orgId`; a permission
   * string additionally requires that permission (role or key scope).
   */
  readonly org?: true | Permission;
  /** Require a session that completed two-factor authentication. */
  readonly requireMfa?: boolean;
  readonly rateLimit?: 'auth' | 'api';
  readonly idempotency?: 'optional' | 'required';
  readonly params?: Schema<P>;
  readonly query?: Schema<Q>;
  readonly body?: Schema<B>;
  /** Output schema. The handler returns its *input* type (e.g. Date); the schema serialises it. */
  readonly response: ZodType<R, ZodTypeDef, RIn>;
  readonly successStatus?: number;
  readonly handler: (ctx: RouteContext<B, Q, P>) => Promise<RIn>;
}

export interface RegisteredRoute {
  readonly method: HttpMethod;
  readonly url: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly auth: AuthMode;
  readonly org: true | Permission | undefined;
  readonly schemas: { params?: ZodType; query?: ZodType; body?: ZodType; response: ZodType };
  readonly successStatus: number;
}

export const routeRegistry: RegisteredRoute[] = [];

const UNSAFE_METHODS = new Set<HttpMethod>(['POST', 'PATCH', 'PUT', 'DELETE']);
const orgParam = z.object({ orgId: z.string().uuid() }).passthrough();

function requestMeta(request: FastifyRequest): RequestMeta {
  const userAgent = request.headers['user-agent'];
  return {
    requestId: request.id,
    ip: request.ip,
    ...(typeof userAgent === 'string' ? { userAgent } : {}),
  };
}

function parseOrThrow<T>(
  schema: Schema<T> | undefined,
  value: unknown,
  location: 'body' | 'query' | 'params',
): T {
  if (!schema) return undefined as T;
  const result = schema.safeParse(value);
  if (!result.success) throw zodToAppError(result.error, location);
  return result.data;
}

async function authenticate(
  ctx: ApiContext,
  request: FastifyRequest,
  mode: AuthMode,
): Promise<Principal | null> {
  const authorization = request.headers.authorization;
  const bearer = bearerToken(authorization);
  if (authorization !== undefined && bearer === undefined)
    throw AppError.unauthenticated('Malformed Authorization header.');

  if (bearer !== undefined) {
    if (mode === 'public') return null;
    if (mode === 'session') throw AppError.forbidden('API keys cannot be used for this endpoint.');
    const key = await authenticateApiKey(ctx.db, ctx.config.network, bearer, request.ip);
    if (!key) throw AppError.unauthenticated('Invalid API key.');
    return { kind: 'api_key', key };
  }

  const token = request.cookies[sessionCookieName(ctx.secureCookies)];
  if (token) {
    const session = await validateSession(ctx.auth, token);
    if (session) return { kind: 'session', session };
  }
  if (mode === 'public') return null;
  throw AppError.unauthenticated();
}

async function resolveOrgAccess(
  ctx: ApiContext,
  principal: Principal,
  organizationId: string,
  requirement: true | Permission,
  method: HttpMethod,
): Promise<OrgAccess & { via: 'member' | 'api_key' }> {
  let access: OrgAccess & { via: 'member' | 'api_key' };
  if (principal.kind === 'api_key') {
    // A key belongs to exactly one organization; other ids look nonexistent.
    if (principal.key.organizationId !== organizationId) throw AppError.notFound('Organization');
    const org = await ctx.db
      .selectFrom('organizations')
      .select('status')
      .where('id', '=', organizationId)
      .executeTakeFirstOrThrow();
    if (org.status !== 'active')
      throw new AppError('ORGANIZATION_SUSPENDED', 'This organization is suspended.');
    access = {
      organizationId,
      organizationStatus: org.status,
      role: null,
      permissions: principal.key.scopes,
      via: 'api_key',
    };
  } else {
    const member = await resolveMemberAccess(ctx.db, organizationId, principal.session.userId);
    if (!member) throw AppError.notFound('Organization');
    if (member.organizationStatus === 'suspended' && method !== 'GET') {
      throw new AppError(
        'ORGANIZATION_SUSPENDED',
        'This organization is suspended; it is read-only.',
      );
    }
    access = { ...member, via: 'member' };
  }
  if (requirement !== true && !access.permissions.has(requirement)) {
    throw AppError.forbidden(`Missing permission: ${requirement}`);
  }
  return access;
}

/**
 * General API limits are per caller, not per IP, so many merchants behind
 * one NAT do not share a bucket. Unauthenticated calls fall back to IP.
 * The key derives from non-secret material (key public id, cookie hash).
 */
function apiRateKey(ctx: ApiContext, request: FastifyRequest): string {
  const bearer = bearerToken(request.headers.authorization);
  const publicId = bearer?.split('_')[2];
  if (bearer && publicId) return `key:${publicId}`;
  const cookie = request.cookies[sessionCookieName(ctx.secureCookies)];
  if (cookie) return `session:${sha256Hex(cookie).slice(0, 32)}`;
  return `ip:${request.ip}`;
}

export function defineRoute<B = undefined, Q = undefined, P = undefined, R = unknown, RIn = R>(
  app: FastifyInstance,
  ctx: ApiContext,
  def: RouteDefinition<B, Q, P, R, RIn>,
): void {
  if (def.org !== undefined && !def.url.includes(':orgId'))
    throw new Error(`${def.url}: org-scoped routes need :orgId`);
  if (def.idempotency && (def.method !== 'POST' || def.org === undefined))
    throw new Error(`${def.url}: idempotency requires an org-scoped POST`);
  if (def.auth === 'public' && def.org !== undefined)
    throw new Error(`${def.url}: public routes cannot be org-scoped`);

  const successStatus = def.successStatus ?? (def.method === 'POST' ? 201 : 200);
  routeRegistry.push({
    method: def.method,
    url: def.url,
    summary: def.summary,
    tags: def.tags,
    auth: def.auth,
    org: def.org,
    schemas: {
      ...(def.params ? { params: def.params } : {}),
      ...(def.query ? { query: def.query } : {}),
      ...(def.body ? { body: def.body } : {}),
      response: def.response,
    },
    successStatus,
  });

  const rateLimit =
    def.rateLimit === 'auth'
      ? {
          max: ctx.config.rateLimits.authPerMinute,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) => `auth:${req.ip}`,
        }
      : {
          max: ctx.config.rateLimits.apiPerMinute,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) => apiRateKey(ctx, req),
        };

  app.route({
    method: def.method,
    url: def.url,
    config: { rateLimit },
    handler: async (request, reply) => {
      const meta = requestMeta(request);

      // A malformed organization id is indistinguishable from an unknown one.
      if (def.org !== undefined && !orgParam.safeParse(request.params).success)
        throw AppError.notFound('Organization');
      const params = parseOrThrow(def.params, request.params, 'params');

      const principal = await authenticate(ctx, request, def.auth);

      if (principal?.kind === 'session' && UNSAFE_METHODS.has(def.method)) {
        const header = request.headers['x-csrf-token'];
        if (
          !verifyCsrfToken(
            ctx.csrfKey,
            principal.session.sessionId,
            typeof header === 'string' ? header : undefined,
          )
        ) {
          throw new AppError('CSRF_FAILED', 'Missing or invalid X-CSRF-Token header.');
        }
      }
      if (def.requireMfa === true) {
        if (principal?.kind !== 'session')
          throw AppError.forbidden('This action requires a signed-in user.');
        if (!principal.session.mfaEnabled || !principal.session.mfaVerified) {
          throw new AppError(
            'MFA_REQUIRED',
            'This action requires two-factor authentication to be enabled and verified.',
          );
        }
      }

      let access: RouteContext<B, Q, P>['access'] = null;
      if (def.org !== undefined) {
        if (!principal) throw AppError.unauthenticated();
        const { orgId } = orgParam.parse(request.params);
        access = await resolveOrgAccess(ctx, principal, orgId, def.org, def.method);
      }

      const query = parseOrThrow(def.query, request.query, 'query');
      const body = parseOrThrow(def.body, request.body ?? {}, 'body');

      let claim: IdempotencyClaim | undefined;
      if (def.idempotency && access && principal) {
        const headerValue = request.headers['idempotency-key'];
        const key = typeof headerValue === 'string' ? headerValue : undefined;
        if (key === undefined && def.idempotency === 'required')
          throw AppError.validation('This endpoint requires an Idempotency-Key header.');
        if (key !== undefined) {
          validateIdempotencyKey(key);
          const callerId =
            principal.kind === 'session'
              ? `user:${principal.session.userId}`
              : `key:${principal.key.apiKeyId}`;
          const outcome = await claimIdempotencyKey(ctx.db, {
            organizationId: access.organizationId,
            scope: `${def.method} ${def.url}`,
            key,
            fingerprint: requestFingerprint({
              method: def.method,
              path: request.url.split('?')[0] ?? '',
              callerId,
              body: request.body ?? null,
            }),
          });
          if (outcome.kind === 'replay') {
            return reply
              .status(outcome.status)
              .header('Idempotent-Replayed', 'true')
              .send(outcome.body);
          }
          claim = outcome.claim;
        }
      }

      try {
        const result = await def.handler({
          request,
          reply,
          body,
          query,
          params,
          meta,
          principal,
          access,
        });
        const output = def.response.parse(result);
        if (claim) await completeIdempotencyKey(ctx.db, claim, successStatus, output);
        // Fastify convention for async handlers that call send(): return the reply.
        if (successStatus === 204) reply.status(204).send();
        else reply.status(successStatus).send(output);
        // FastifyReply is thenable, which trips return-await; returning the
        // reply object itself is the documented Fastify pattern.
        // eslint-disable-next-line @typescript-eslint/return-await
        return reply;
      } catch (error) {
        if (claim) {
          const status = isAppError(error) ? error.httpStatus : 500;
          const errorBody = isAppError(error)
            ? {
                error: {
                  code: error.code,
                  message: error.message,
                  requestId: request.id,
                  ...(error.details ? { details: error.details } : {}),
                },
              }
            : null;
          await completeIdempotencyKey(ctx.db, claim, status, errorBody).catch((e: unknown) => {
            request.log.error({ err: e }, 'failed to record idempotency outcome');
          });
        }
        throw error;
      }
    },
  });
}

export type { ApiKeyScope };
