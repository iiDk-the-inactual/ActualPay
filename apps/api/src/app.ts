/**
 * Builds the Fastify application. `server.ts` wires real dependencies;
 * tests call `buildApp` directly with a test database and in-memory mailer.
 */
import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Redis } from 'ioredis';
import { AppError, type Logger } from '@actualpay/shared';
import type { AppConfig } from '@actualpay/config';
import type { Db } from '@actualpay/database';
import type { Mailer } from '@actualpay/email';
import { deriveKey, SecretBox, type AuthDeps } from '@actualpay/auth';
import type { ApiContext } from './http/context';
import { registerErrorHandling } from './http/errors';
import { resilientStore } from './http/rate-limit-store';
import { registerAuthRoutes } from './routes/auth';
import { registerHealthRoutes } from './routes/health';
import { registerMeRoutes } from './routes/me';
import { registerOrganizationRoutes } from './routes/organizations';

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly db: Db;
  readonly logger: Logger;
  readonly mailer: Mailer;
  /** Shared rate-limit counters. `null` uses per-process memory only. */
  readonly redis: Redis | null;
}

export async function buildApp(
  options: BuildAppOptions,
): Promise<{ app: FastifyInstance; ctx: ApiContext }> {
  const { config, db, logger, mailer, redis } = options;

  // Typed as Fastify's base logger so the instance type matches route helpers.
  const fastifyLogger: FastifyBaseLogger = logger;
  const app = Fastify({
    // Typed as Fastify's base logger so the instance type matches route helpers.
    loggerInstance: fastifyLogger,
    trustProxy: config.trustProxy,
    bodyLimit: 100 * 1024,
    // Reject JSON bodies trying to set __proto__ / constructor.prototype.
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    genReqId: () => `req_${randomBytes(12).toString('base64url')}`,
    requestIdHeader: false, // never trust a client-supplied request id
    requestIdLogLabel: 'requestId',
    return503OnClosing: true,
    routerOptions: { maxParamLength: 200 },
  });

  const authDeps: AuthDeps = {
    db,
    mailer,
    logger,
    appName: config.appName,
    publicBaseUrl: config.publicBaseUrl,
    network: config.network,
    totpBox: new SecretBox(config.secrets.encryptionKey, 'totp'),
    sessionPolicy: config.sessionPolicy,
    lockoutPolicy: config.lockoutPolicy,
  };
  const ctx: ApiContext = {
    config,
    db,
    logger,
    auth: authDeps,
    csrfKey: deriveKey(config.secrets.sessionSecret, 'csrf'),
    // Plain-HTTP cookies are only allowed in development and test.
    secureCookies:
      config.publicBaseUrl.protocol === 'https:' ||
      (config.env !== 'development' && config.env !== 'test'),
  };

  registerErrorHandling(app, config.env === 'development');
  // JSON only: anything else is rejected with 415 instead of reaching handlers as a string.
  app.removeContentTypeParser(['text/plain']);

  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
    // API responses contain account data; never let shared caches keep them.
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
  });

  await app.register(helmet, {
    // JSON API: forbid everything a browser could render or frame.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  if (config.api.corsAllowedOrigins.length > 0) {
    await app.register(cors, {
      origin: [...config.api.corsAllowedOrigins],
      // Cross-origin callers authenticate with API keys, never cookies.
      credentials: false,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
      maxAge: 600,
    });
  }

  await app.register(cookie, { hook: 'onRequest' });

  await app.register(rateLimit, {
    global: false,
    // Shared counters in Redis, falling back to per-instance counters if
    // Redis is down, so limits degrade but never disappear.
    ...(redis ? { store: resilientStore(redis, logger, 'actualpay-rl:') } : {}),
    skipOnError: false,
    errorResponseBuilder: (_request, context) => {
      const error = new AppError(
        'RATE_LIMITED',
        `Too many requests. Retry after ${Math.ceil(context.ttl / 1000)} seconds.`,
      );
      return error;
    },
  });

  registerHealthRoutes(app, ctx, redis);
  registerAuthRoutes(app, ctx);
  registerMeRoutes(app, ctx);
  registerOrganizationRoutes(app, ctx);

  return { app, ctx };
}
