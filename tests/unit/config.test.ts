import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadConfig } from '@actualpay/config';

const key = () => randomBytes(32).toString('base64');

function baseEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    APP_ENV: 'development',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgres://u:secretpw@localhost:5432/actualpay',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: key(),
    NETWORK_MODE: 'testnet',
    ENABLED_ASSETS: 'xrp',
    XRPL_WS_URL: 'wss://s.altnet.rippletest.net:51233',
    ...overrides,
  };
}

function issues(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.issues];
    throw error;
  }
  return [];
}

describe('loadConfig', () => {
  it('accepts a minimal valid development config', () => {
    const config = loadConfig(baseEnv());
    expect(config.enabledAssets).toEqual(['xrp']);
    expect(config.secrets.encryptionKey).toHaveLength(32);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('reports every missing required value at once', () => {
    const found = issues({ APP_ENV: 'development' });
    expect(found.some((i) => i.startsWith('DATABASE_URL'))).toBe(true);
    expect(found.some((i) => i.startsWith('ENCRYPTION_KEY'))).toBe(true);
    expect(found.some((i) => i.startsWith('NETWORK_MODE'))).toBe(true);
  });

  it('never echoes secret values in errors', () => {
    const error = (() => {
      try {
        loadConfig(baseEnv({ ENCRYPTION_KEY: 'super-secret-but-too-short' }));
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect(error?.message).not.toContain('super-secret-but-too-short');
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    expect(issues(baseEnv({ ENCRYPTION_KEY: randomBytes(16).toString('base64') }))[0]).toMatch(
      /ENCRYPTION_KEY/,
    );
  });

  it('requires chain RPC settings only for enabled chains', () => {
    expect(issues(baseEnv({ ENABLED_ASSETS: 'btc' })).join()).toMatch(/BITCOIN_RPC_URL/);
    expect(issues(baseEnv({ ENABLED_ASSETS: 'xrp' }))).toEqual([]);
  });

  it('rejects unknown assets and tokens without their fee asset', () => {
    expect(issues(baseEnv({ ENABLED_ASSETS: 'doge' })).join()).toMatch(/unknown asset/);
    const found = issues(
      baseEnv({
        ENABLED_ASSETS: 'usdt-erc20',
        ETHEREUM_RPC_URL: 'http://localhost:8545',
        USDT_ERC20_CONTRACT: '0xabc',
      }),
    );
    expect(found.join()).toMatch(/fee asset eth/);
  });

  it('requires a testnet token contract and forbids overriding the mainnet one', () => {
    const testnet = baseEnv({
      ENABLED_ASSETS: 'eth,usdt-erc20',
      ETHEREUM_RPC_URL: 'http://localhost:8545',
    });
    expect(issues(testnet).join()).toMatch(/USDT_ERC20_CONTRACT/);

    const mainnet = baseEnv({
      NETWORK_MODE: 'mainnet',
      ENABLED_ASSETS: 'eth,usdt-erc20',
      ETHEREUM_RPC_URL: 'http://localhost:8545',
      USDT_ERC20_CONTRACT: '0x0000000000000000000000000000000000000001',
    });
    expect(issues(mainnet).join()).toMatch(/must not override/);

    const ok = loadConfig({ ...mainnet, USDT_ERC20_CONTRACT: undefined });
    expect(ok.tokenContracts['usdt-erc20']).toBe('0xdAC17F958D2ee523a2206206994597C13D831ec7');
  });

  it('applies production hardening rules', () => {
    const found = issues(
      baseEnv({
        APP_ENV: 'production',
        LOG_LEVEL: 'debug',
        SESSION_SECRET: 'change-me-change-me-change-me-change-me',
      }),
    ).join('\n');
    expect(found).toMatch(/PUBLIC_BASE_URL: must use https/);
    expect(found).toMatch(/NETWORK_MODE: production must use mainnet/);
    expect(found).toMatch(/LOG_LEVEL/);
    expect(found).toMatch(/SESSION_SECRET: looks like a placeholder/);
    expect(found).toMatch(/SMTP_HOST: production requires SMTP/);
  });

  it('makes Redis optional outside production but required in production', () => {
    expect(issues(baseEnv({ REDIS_URL: undefined }))).toEqual([]);
    expect(loadConfig(baseEnv({ REDIS_URL: '' })).redis.url).toBeUndefined();
    expect(describeConfig(loadConfig(baseEnv({ REDIS_URL: '' }))).redis).toMatch(/not configured/);
    const found = issues(baseEnv({ APP_ENV: 'production', REDIS_URL: undefined })).join('\n');
    expect(found).toMatch(/REDIS_URL: production requires Redis/);
  });

  it('refuses development-only webhook relaxations in production', () => {
    const found = issues(
      baseEnv({
        APP_ENV: 'production',
        WEBHOOK_ALLOW_HTTP: 'true',
        WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true',
      }),
    ).join('\n');
    expect(found).toMatch(/WEBHOOK_ALLOW_HTTP: must be false in production/);
    expect(found).toMatch(/WEBHOOK_ALLOW_PRIVATE_NETWORKS: must be false in production/);
    const dev = loadConfig(
      baseEnv({ WEBHOOK_ALLOW_HTTP: 'true', WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true' }),
    );
    expect(dev.webhooks).toEqual({ allowHttp: true, allowPrivateNetworks: true });
    expect(loadConfig(baseEnv({})).webhooks).toEqual({
      allowHttp: false,
      allowPrivateNetworks: false,
    });
  });

  it('treats empty strings as unset', () => {
    expect(issues(baseEnv({ BITCOIN_RPC_URL: '' }))).toEqual([]);
  });

  it('reads *_FILE secrets and rejects ambiguous double definitions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'actualpay-'));
    const file = join(dir, 'session');
    const secret = randomBytes(32).toString('hex');
    writeFileSync(file, `${secret}\n`);
    const config = loadConfig(baseEnv({ SESSION_SECRET: undefined, SESSION_SECRET_FILE: file }));
    expect(config.secrets.sessionSecret).toBe(secret);
    expect(() => loadConfig(baseEnv({ SESSION_SECRET_FILE: file }))).toThrow(
      /Both SESSION_SECRET and SESSION_SECRET_FILE/,
    );
  });

  it('ignores unrelated *_FILE variables from the environment', () => {
    expect(() =>
      loadConfig(baseEnv({ PIP_CONFIG_FILE: '/nonexistent/pip.conf', KUBECONFIG_FILE: '/nope' })),
    ).not.toThrow();
  });

  it('describeConfig contains no credentials', () => {
    const text = JSON.stringify(describeConfig(loadConfig(baseEnv())));
    expect(text).not.toContain('secretpw');
    expect(text).toContain('localhost:5432');
  });
});

describe('custody and withdrawal settings', () => {
  it('defaults to merchant custody, which needs no seal key', () => {
    const config = loadConfig(baseEnv());
    expect(config.custody.mode).toBe('merchant');
  });

  it('requires a seal key in platform mode and never prints it', () => {
    expect(issues(baseEnv({ CUSTODY_MODE: 'platform' })).join('\n')).toMatch(/WITHDRAWAL_SEAL_KEY/);
    const sealKey = key();
    const config = loadConfig(baseEnv({ CUSTODY_MODE: 'platform', WITHDRAWAL_SEAL_KEY: sealKey }));
    expect(config.custody.mode).toBe('platform');
    expect(JSON.stringify(describeConfig(config))).not.toContain(sealKey);
  });

  it('rejects a seal key that is not 32 bytes', () => {
    expect(
      issues(
        baseEnv({
          CUSTODY_MODE: 'platform',
          WITHDRAWAL_SEAL_KEY: Buffer.alloc(8).toString('base64'),
        }),
      ).join('\n'),
    ).toMatch(/WITHDRAWAL_SEAL_KEY/);
  });

  it('refuses zero cool-down or policy delay in production platform mode', () => {
    const found = issues(
      baseEnv({
        APP_ENV: 'production',
        CUSTODY_MODE: 'platform',
        WITHDRAWAL_SEAL_KEY: key(),
        WITHDRAWAL_DESTINATION_COOLDOWN_HOURS: '0',
        WITHDRAWAL_POLICY_INCREASE_DELAY_HOURS: '0',
      }),
    ).join('\n');
    expect(found).toMatch(/WITHDRAWAL_DESTINATION_COOLDOWN_HOURS/);
    expect(found).toMatch(/WITHDRAWAL_POLICY_INCREASE_DELAY_HOURS/);
  });

  it('refuses webhook SSRF escape hatches in production', () => {
    const found = issues(
      baseEnv({
        APP_ENV: 'production',
        WEBHOOK_ALLOW_HTTP: 'true',
        WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true',
      }),
    ).join('\n');
    expect(found).toMatch(/WEBHOOK_ALLOW_HTTP/);
    expect(found).toMatch(/WEBHOOK_ALLOW_PRIVATE_NETWORKS/);
  });
});
