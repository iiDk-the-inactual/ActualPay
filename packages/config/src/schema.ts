/**
 * The complete configuration contract, validated once at startup.
 *
 * Rules:
 *  - Missing or malformed required values abort startup (fail fast).
 *  - There are no insecure defaults that silently apply in production.
 *  - Chain RPC settings are required only for enabled assets.
 *  - `production` adds stricter rules on top (see `productionRules`).
 */
import { z } from 'zod';
import {
  ASSET_IDS,
  ASSETS,
  NETWORK_MODES,
  type AssetId,
  type ChainFamily,
} from '@actualpay/shared';

export const APP_ENVS = ['development', 'test', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** Values that indicate a placeholder was copied from .env.example. */
const PLACEHOLDER_PATTERN = /change[-_]?me|replace[-_]?me|example|placeholder|xxxx/i;

const nonEmpty = z.string().trim().min(1);

/** A 32-byte key encoded as base64 (e.g. `openssl rand -base64 32`). */
const base64Key32 = nonEmpty.refine(
  (value) => {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
    return Buffer.from(value, 'base64').length === 32;
  },
  { message: 'must be exactly 32 random bytes, base64-encoded (openssl rand -base64 32)' },
);

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const urlWithProtocols = (protocols: readonly string[]) =>
  nonEmpty.url().refine((value) => protocols.includes(new URL(value).protocol), {
    message: `must use one of: ${protocols.join(', ')}`,
  });

const enabledAssets = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const ids = value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    const unique = [...new Set(ids)];
    for (const id of unique) {
      if (!(ASSET_IDS as readonly string[]).includes(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown asset "${id}"; valid: ${ASSET_IDS.join(', ')}`,
        });
        return z.NEVER;
      }
    }
    return unique as AssetId[];
  });

export const rawConfigSchema = z.object({
  APP_ENV: z.enum(APP_ENVS),
  APP_NAME: nonEmpty.max(64).default('ActualPay'),
  PUBLIC_BASE_URL: urlWithProtocols(['http:', 'https:']),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: urlWithProtocols(['postgres:', 'postgresql:']),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  DATABASE_SSL: booleanString.default('false'),

  REDIS_URL: urlWithProtocols(['redis:', 'rediss:']),

  SESSION_SECRET: nonEmpty.min(32, 'must be at least 32 characters'),
  ENCRYPTION_KEY: base64Key32,

  NETWORK_MODE: z.enum(NETWORK_MODES),
  ENABLED_ASSETS: enabledAssets,

  BITCOIN_RPC_URL: urlWithProtocols(['http:', 'https:']).optional(),
  BITCOIN_RPC_USERNAME: nonEmpty.optional(),
  BITCOIN_RPC_PASSWORD: nonEmpty.optional(),
  LITECOIN_RPC_URL: urlWithProtocols(['http:', 'https:']).optional(),
  LITECOIN_RPC_USERNAME: nonEmpty.optional(),
  LITECOIN_RPC_PASSWORD: nonEmpty.optional(),
  ETHEREUM_RPC_URL: urlWithProtocols(['http:', 'https:', 'ws:', 'wss:']).optional(),
  TRON_API_URL: urlWithProtocols(['http:', 'https:']).optional(),
  TRON_API_KEY: nonEmpty.optional(),
  XRPL_WS_URL: urlWithProtocols(['ws:', 'wss:']).optional(),

  BITCOIN_WALLET_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .default('actualpay_watch'),
  BITCOIN_CONFIRMATIONS: z.coerce.number().int().min(1).max(100).default(2),
  LITECOIN_WALLET_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .default('actualpay_watch'),
  LITECOIN_CONFIRMATIONS: z.coerce.number().int().min(1).max(200).default(6),
  /** Litecoin Core release builds lack descriptor wallets; switch only if your build has them. */
  LITECOIN_WALLET_MODE: z.enum(['legacy', 'descriptor']).default('legacy'),
  /** Defaults: 1 on mainnet, 11155111 (Sepolia) on testnet. */
  ETHEREUM_CHAIN_ID: z.coerce.number().int().positive().optional(),
  XRPL_DEPOSIT_ACCOUNT: nonEmpty
    .regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/, 'must be a classic XRPL address (r…)')
    .optional(),

  USDT_ERC20_CONTRACT: nonEmpty.optional(),
  USDT_TRC20_CONTRACT: nonEmpty.optional(),

  SMTP_HOST: nonEmpty.optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  SMTP_USERNAME: nonEmpty.optional(),
  SMTP_PASSWORD: nonEmpty.optional(),
  SMTP_FROM: nonEmpty.email().optional(),

  TRUST_PROXY: booleanString.default('false'),

  API_HOST: nonEmpty.default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Comma-separated exact origins allowed to call the API from browsers. */
  CORS_ALLOWED_ORIGINS: z
    .string()
    .trim()
    .default('')
    .transform((value, ctx) => {
      const origins = value
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0);
      for (const origin of origins) {
        let parsed: URL;
        try {
          parsed = new URL(origin);
        } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid origin "${origin}"` });
          return z.NEVER;
        }
        if (parsed.origin !== origin) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${origin}" must be a bare origin like https://shop.example`,
          });
          return z.NEVER;
        }
      }
      return origins;
    }),

  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(100).default(10),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

  /** Requests per minute per client IP on authentication endpoints. */
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(10),
  /** Requests per minute per API key / session on the general API. */
  RATE_LIMIT_API_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(600),
});

export type RawConfig = z.infer<typeof rawConfigSchema>;

/** Which RPC settings each chain family needs when one of its assets is enabled. */
const CHAIN_REQUIREMENTS: Readonly<Record<ChainFamily, readonly (keyof RawConfig)[]>> = {
  bitcoin: ['BITCOIN_RPC_URL', 'BITCOIN_RPC_USERNAME', 'BITCOIN_RPC_PASSWORD'],
  litecoin: ['LITECOIN_RPC_URL', 'LITECOIN_RPC_USERNAME', 'LITECOIN_RPC_PASSWORD'],
  ethereum: ['ETHEREUM_RPC_URL'],
  tron: ['TRON_API_URL'],
  xrpl: ['XRPL_WS_URL'],
};

const CONTRACT_OVERRIDE_KEYS: Partial<Record<AssetId, keyof RawConfig>> = {
  'usdt-erc20': 'USDT_ERC20_CONTRACT',
  'usdt-trc20': 'USDT_TRC20_CONTRACT',
};

export function crossFieldRules(config: RawConfig, ctx: z.RefinementCtx): void {
  if (config.ENABLED_ASSETS.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ENABLED_ASSETS'],
      message: 'enable at least one asset',
    });
  }

  const chains = new Set(config.ENABLED_ASSETS.map((id) => ASSETS[id].chain));
  for (const chain of chains) {
    for (const key of CHAIN_REQUIREMENTS[chain]) {
      if (config[key] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `required because a ${chain} asset is enabled`,
        });
      }
    }
  }

  for (const id of config.ENABLED_ASSETS) {
    const asset = ASSETS[id];
    // Tokens pay fees in their chain's native asset, so that asset must be
    // enabled too, or fee accounting and gas top-ups have nowhere to live.
    if (!config.ENABLED_ASSETS.includes(asset.feeAssetId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ENABLED_ASSETS'],
        message: `${id} requires its fee asset ${asset.feeAssetId} to be enabled`,
      });
    }
    const overrideKey = CONTRACT_OVERRIDE_KEYS[id];
    if (asset.contract && overrideKey) {
      const builtIn = asset.contract[config.NETWORK_MODE];
      const override = config[overrideKey];
      if (builtIn === null && override === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [overrideKey],
          message: `required for ${id} on ${config.NETWORK_MODE} (no official contract)`,
        });
      }
      if (builtIn !== null && override !== undefined && override !== builtIn) {
        // Overriding a mainnet token contract would let a misconfiguration
        // credit worthless look-alike tokens as real USDT.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [overrideKey],
          message: `must not override the official ${id} contract on ${config.NETWORK_MODE}`,
        });
      }
    }
  }

  const smtpKeys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM'] as const;
  const smtpSet = smtpKeys.filter((key) => config[key] !== undefined);
  if (smtpSet.length > 0 && smtpSet.length < smtpKeys.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMTP_HOST'],
      message: 'SMTP_HOST, SMTP_PORT and SMTP_FROM must be set together (or not at all)',
    });
  }
}

const SECRET_KEYS = [
  'SESSION_SECRET',
  'ENCRYPTION_KEY',
  'BITCOIN_RPC_PASSWORD',
  'LITECOIN_RPC_PASSWORD',
  'SMTP_PASSWORD',
  'TRON_API_KEY',
] as const;

export function productionRules(config: RawConfig, ctx: z.RefinementCtx): void {
  if (config.APP_ENV !== 'production') return;

  if (new URL(config.PUBLIC_BASE_URL).protocol !== 'https:') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PUBLIC_BASE_URL'],
      message: 'must use https in production',
    });
  }
  if (config.NETWORK_MODE !== 'mainnet') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['NETWORK_MODE'],
      message: 'production must use mainnet; use APP_ENV=staging for testnet deployments',
    });
  }
  if (config.SMTP_HOST === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMTP_HOST'],
      message: 'production requires SMTP: account verification and password reset depend on email',
    });
  }
  for (const origin of config.CORS_ALLOWED_ORIGINS) {
    if (!origin.startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ALLOWED_ORIGINS'],
        message: `${origin} must use https in production`,
      });
    }
  }
  if (config.ETHEREUM_CHAIN_ID !== undefined && config.ETHEREUM_CHAIN_ID !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ETHEREUM_CHAIN_ID'],
      message: 'production must use Ethereum mainnet (chain id 1)',
    });
  }
  if (config.LOG_LEVEL === 'trace' || config.LOG_LEVEL === 'debug') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['LOG_LEVEL'],
      message: 'debug/trace logging is not allowed in production',
    });
  }
  for (const key of SECRET_KEYS) {
    const value = config[key];
    if (value !== undefined && PLACEHOLDER_PATTERN.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: 'looks like a placeholder value',
      });
    }
  }
}

/**
 * Field-level validation runs first; cross-field and production rules only
 * run on a fully valid record, so they never see half-parsed values.
 */
export const configSchema = rawConfigSchema.pipe(
  z.custom<RawConfig>().superRefine((config, ctx) => {
    crossFieldRules(config, ctx);
    productionRules(config, ctx);
  }),
);
