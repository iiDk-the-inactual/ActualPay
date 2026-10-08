/**
 * Typed, validated application configuration.
 *
 * `loadConfig()` is called exactly once per process at startup. It throws a
 * ConfigError listing every problem at once (so operators fix them in one
 * pass) and never echoes secret values back.
 */
import { ASSETS, type AssetId, type NetworkMode } from '@actualpay/shared';
import { configSchema, rawConfigSchema, type AppEnv, type RawConfig } from './schema';
import { resolveFileSecrets, type RawEnv } from './env-source';

export { APP_ENVS, type AppEnv } from './schema';
export { resolveFileSecrets } from './env-source';

export class ConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export interface AppConfig {
  readonly env: AppEnv;
  readonly isProduction: boolean;
  readonly appName: string;
  readonly publicBaseUrl: URL;
  readonly logLevel: RawConfig['LOG_LEVEL'];
  readonly trustProxy: boolean;
  readonly api: {
    readonly host: string;
    readonly port: number;
    readonly corsAllowedOrigins: readonly string[];
  };
  readonly sessionPolicy: { readonly idleMinutes: number; readonly absoluteHours: number };
  readonly lockoutPolicy: { readonly maxFailures: number; readonly lockMinutes: number };
  readonly rateLimits: { readonly authPerMinute: number; readonly apiPerMinute: number };
  readonly database: { readonly url: string; readonly poolMax: number; readonly ssl: boolean };
  readonly redis: { readonly url: string };
  readonly secrets: { readonly sessionSecret: string; readonly encryptionKey: Buffer };
  readonly network: NetworkMode;
  readonly enabledAssets: readonly AssetId[];
  /** Effective token contract per enabled token asset. */
  readonly tokenContracts: Readonly<Partial<Record<AssetId, string>>>;
  readonly chains: {
    readonly bitcoin?: {
      url: string;
      username: string;
      password: string;
      walletName: string;
      confirmations: number;
    };
    readonly litecoin?: {
      url: string;
      username: string;
      password: string;
      walletName: string;
      confirmations: number;
      walletMode: 'legacy' | 'descriptor';
    };
    readonly ethereum?: { url: string; chainId: number };
    readonly tron?: { url: string; apiKey?: string };
    readonly xrpl?: { url: string; depositAccount?: string };
  };
  readonly smtp?: {
    readonly host: string;
    readonly port: number;
    readonly from: string;
    readonly username?: string;
    readonly password?: string;
  };
}

function rpcCredentials(url?: string, username?: string, password?: string) {
  return url && username && password ? { url, username, password } : undefined;
}

export function loadConfig(env: RawEnv = process.env): AppConfig {
  const resolved = resolveFileSecrets(env, Object.keys(rawConfigSchema.shape));
  // Treat empty strings as "unset" so `FOO=` in a .env file behaves like an absent key.
  const cleaned = Object.fromEntries(Object.entries(resolved).filter(([, value]) => value !== ''));
  const result = configSchema.safeParse(cleaned);
  if (!result.success) {
    // Only paths and messages; never the received values (they may be secrets).
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const c = result.data;

  const tokenContracts: Partial<Record<AssetId, string>> = {};
  for (const id of c.ENABLED_ASSETS) {
    const contract = ASSETS[id].contract;
    if (!contract) continue;
    const override = id === 'usdt-erc20' ? c.USDT_ERC20_CONTRACT : c.USDT_TRC20_CONTRACT;
    const effective = contract[c.NETWORK_MODE] ?? override;
    if (effective) tokenContracts[id] = effective;
  }

  const chains: Record<string, unknown> = {};
  const bitcoin = rpcCredentials(c.BITCOIN_RPC_URL, c.BITCOIN_RPC_USERNAME, c.BITCOIN_RPC_PASSWORD);
  if (bitcoin)
    chains['bitcoin'] = {
      ...bitcoin,
      walletName: c.BITCOIN_WALLET_NAME,
      confirmations: c.BITCOIN_CONFIRMATIONS,
    };
  const litecoin = rpcCredentials(
    c.LITECOIN_RPC_URL,
    c.LITECOIN_RPC_USERNAME,
    c.LITECOIN_RPC_PASSWORD,
  );
  if (litecoin)
    chains['litecoin'] = {
      ...litecoin,
      walletName: c.LITECOIN_WALLET_NAME,
      confirmations: c.LITECOIN_CONFIRMATIONS,
      walletMode: c.LITECOIN_WALLET_MODE,
    };
  if (c.ETHEREUM_RPC_URL)
    chains['ethereum'] = {
      url: c.ETHEREUM_RPC_URL,
      chainId: c.ETHEREUM_CHAIN_ID ?? (c.NETWORK_MODE === 'mainnet' ? 1 : 11155111),
    };
  if (c.TRON_API_URL) {
    chains['tron'] = c.TRON_API_KEY
      ? { url: c.TRON_API_URL, apiKey: c.TRON_API_KEY }
      : { url: c.TRON_API_URL };
  }
  if (c.XRPL_WS_URL)
    chains['xrpl'] = c.XRPL_DEPOSIT_ACCOUNT
      ? { url: c.XRPL_WS_URL, depositAccount: c.XRPL_DEPOSIT_ACCOUNT }
      : { url: c.XRPL_WS_URL };

  const config: AppConfig = {
    env: c.APP_ENV,
    isProduction: c.APP_ENV === 'production',
    appName: c.APP_NAME,
    publicBaseUrl: new URL(c.PUBLIC_BASE_URL),
    logLevel: c.LOG_LEVEL,
    trustProxy: c.TRUST_PROXY,
    api: { host: c.API_HOST, port: c.API_PORT, corsAllowedOrigins: c.CORS_ALLOWED_ORIGINS },
    sessionPolicy: { idleMinutes: c.SESSION_IDLE_MINUTES, absoluteHours: c.SESSION_ABSOLUTE_HOURS },
    lockoutPolicy: { maxFailures: c.LOGIN_MAX_FAILURES, lockMinutes: c.LOGIN_LOCK_MINUTES },
    rateLimits: {
      authPerMinute: c.RATE_LIMIT_AUTH_PER_MINUTE,
      apiPerMinute: c.RATE_LIMIT_API_PER_MINUTE,
    },
    database: { url: c.DATABASE_URL, poolMax: c.DATABASE_POOL_MAX, ssl: c.DATABASE_SSL },
    redis: { url: c.REDIS_URL },
    secrets: {
      sessionSecret: c.SESSION_SECRET,
      encryptionKey: Buffer.from(c.ENCRYPTION_KEY, 'base64'),
    },
    network: c.NETWORK_MODE,
    enabledAssets: c.ENABLED_ASSETS,
    tokenContracts,
    chains: chains,
    ...(c.SMTP_HOST && c.SMTP_PORT && c.SMTP_FROM
      ? {
          smtp: {
            host: c.SMTP_HOST,
            port: c.SMTP_PORT,
            from: c.SMTP_FROM,
            ...(c.SMTP_USERNAME ? { username: c.SMTP_USERNAME } : {}),
            ...(c.SMTP_PASSWORD ? { password: c.SMTP_PASSWORD } : {}),
          },
        }
      : {}),
  };
  return Object.freeze(config);
}

/**
 * A config summary that is safe to log or show on a health page:
 * no secrets, no credentials embedded in URLs.
 */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  const host = (url: string) => {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
    } catch {
      return '(invalid)';
    }
  };
  return {
    env: config.env,
    appName: config.appName,
    publicBaseUrl: config.publicBaseUrl.origin,
    network: config.network,
    enabledAssets: config.enabledAssets,
    database: host(config.database.url),
    redis: host(config.redis.url),
    chains: Object.fromEntries(
      Object.entries(config.chains).map(([name, value]) => [name, host(value.url)]),
    ),
    smtpConfigured: config.smtp !== undefined,
  };
}
