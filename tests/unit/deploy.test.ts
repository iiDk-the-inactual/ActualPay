/**
 * The production compose files stay consistent with the application: every
 * variable they set exists, a production configuration built from them is
 * valid, and the container hardening is not quietly loosened.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, loadConfig } from '@actualpay/config';

type Service = {
  environment?: Record<string, string>;
  ports?: string[];
  read_only?: boolean;
  cap_drop?: string[];
  cap_add?: string[];
  security_opt?: string[];
  secrets?: string[];
  user?: string;
  command?: string[];
};
interface Compose {
  services: Record<string, Service>;
  secrets: Record<string, { file: string }>;
  networks: Record<string, { internal?: boolean }>;
}
const load = (path: string): Compose =>
  parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'), {
    merge: true,
  }) as Compose;

const prod = load('deploy/docker-compose.prod.yml');
const signer = load('deploy/signer/docker-compose.signer.yml');

/** Environment of a service after YAML anchors and merges, with ${VAR:-default} resolved. */
function envOf(service: Service, vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(service.environment ?? {})) {
    out[key] = raw.replace(
      /\$\{([A-Z_]+)(:-([^}]*)|:\?[^}]*)?\}/g,
      (_m, name: string, _x, dflt: string | undefined) => vars[name] ?? dflt ?? '',
    );
  }
  return out;
}

const vars = {
  ACTUALPAY_IMAGE: 'x/y:1',
  PUBLIC_BASE_URL: 'https://pay.example.com',
  ENABLED_ASSETS: 'btc,eth',
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_FROM: 'no-reply@example.com',
  OPERATOR_ALERT_EMAIL: 'ops@example.com',
  BITCOIN_RPC_URL: 'http://10.0.0.5:8332',
  BITCOIN_RPC_USERNAME: 'rpc',
  ETHEREUM_RPC_URL: 'http://10.0.0.6:8545',
};

/** Point every *_FILE variable at a real temp file, as Docker secrets would. */
function withSecretFiles(env: Record<string, string>): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'ap-secrets-'));
  const out = { ...env };
  for (const [key, value] of Object.entries(env)) {
    if (!key.endsWith('_FILE')) continue;
    const name = value.split('/').pop() ?? key;
    const file = join(dir, name);
    const content =
      name === 'database_app_url'
        ? 'postgres://actualpay_app:pw@postgres:5432/actualpay'
        : name === 'redis_url'
          ? 'redis://:pw@valkey:6379'
          : name === 'session_secret'
            ? randomBytes(32).toString('hex')
            : name === 'encryption_key' || name === 'withdrawal_seal_key'
              ? randomBytes(32).toString('base64')
              : name === 'bitcoin_rpc_password'
                ? randomBytes(12).toString('hex')
                : ''; // unused optional secrets are empty files
    writeFileSync(file, content);
    out[key] = file;
  }
  return out;
}

describe('docker-compose.prod.yml', () => {
  const api = prod.services['api'] as Service;

  it('sets only variables the application knows (catches typos)', () => {
    for (const service of ['api', 'worker', 'migrate'] as const) {
      const env = prod.services[service]?.environment ?? {};
      for (const key of Object.keys(env)) {
        const base = key.endsWith('_FILE') ? key.slice(0, -5) : key;
        if (['DATABASE_APP_ROLE'].includes(base)) continue;
        expect(CONFIG_KEYS, `${service}: ${key}`).toContain(base);
      }
    }
  });

  it('produces a valid production configuration (both modes)', () => {
    for (const custody of ['merchant', 'platform']) {
      const env = withSecretFiles({
        ...envOf(api, vars),
        CUSTODY_MODE: custody,
        NETWORK_MODE: 'mainnet',
      });
      if (custody === 'platform') {
        env['WITHDRAWAL_DESTINATION_COOLDOWN_HOURS'] = '24';
        env['WITHDRAWAL_POLICY_INCREASE_DELAY_HOURS'] = '24';
      }
      const config = loadConfig(env);
      expect(config.env).toBe('production');
      expect(config.custody.mode).toBe(custody);
      expect(config.publicBaseUrl.protocol).toBe('https:');
    }
  });

  it('exposes only the reverse proxy, and keeps data stores off the internet', () => {
    const published = Object.entries(prod.services).filter(([, s]) => (s.ports ?? []).length > 0);
    expect(published.map(([name]) => name)).toEqual(['caddy']);
    expect(prod.networks['backend']?.internal).toBe(true);
    expect(prod.networks['edge']?.internal).toBe(true);
  });

  it('hardens every application container', () => {
    for (const name of ['api', 'worker', 'migrate']) {
      const s = prod.services[name] as Service;
      expect(s.read_only, name).toBe(true);
      expect(s.cap_drop, name).toEqual(['ALL']);
      expect(s.security_opt, name).toContain('no-new-privileges:true');
      expect(s.user ?? 'node', name).not.toBe('root');
    }
  });

  it('declares every secret it uses, and never passes secrets as plain values', () => {
    for (const [name, s] of Object.entries(prod.services))
      for (const secret of s.secrets ?? [])
        expect(prod.secrets[secret], `${name}: ${secret}`).toBeDefined();
    for (const s of Object.values(prod.services))
      for (const [key, value] of Object.entries(s.environment ?? {}))
        if (
          /(PASSWORD|SECRET|KEY|URL)$/.test(key) &&
          !key.endsWith('_FILE') &&
          key !== 'PUBLIC_BASE_URL'
        )
          expect(value, key).toMatch(/^\$\{[A-Z_]+(:-)?\}$|^$|^https?:/);
  });

  it('runs migrations as the owner and the application as the limited role', () => {
    const migrate = prod.services['migrate'] as Service;
    expect(migrate.environment?.['DATABASE_URL_FILE']).toContain('owner');
    expect(api.environment?.['DATABASE_URL_FILE']).toContain('app');
    expect(JSON.stringify(api.secrets)).not.toContain('owner');
  });
});

describe('signer compose file', () => {
  const s = signer.services['signer'] as Service;

  it('publishes no port and is hardened', () => {
    expect(s.ports ?? []).toEqual([]);
    expect(s.read_only).toBe(true);
    expect(s.cap_drop).toEqual(['ALL']);
    expect(s.security_opt).toContain('no-new-privileges:true');
  });

  it('builds a valid platform-mode production configuration', () => {
    const env = withSecretFiles({
      ...envOf(s, vars),
      NETWORK_MODE: 'mainnet',
      WITHDRAWAL_DESTINATION_COOLDOWN_HOURS: '24',
      WITHDRAWAL_POLICY_INCREASE_DELAY_HOURS: '24',
    });
    const config = loadConfig(env);
    expect(config.custody.mode).toBe('platform');
  });
});

describe('Dockerfile', () => {
  const text = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');

  it('runs as an unprivileged user with production dependencies only', () => {
    expect(text).toMatch(/^USER node$/m);
    expect(text).toMatch(/npm ci --omit=dev --ignore-scripts/);
    expect(text).not.toMatch(/\bsudo\b|chmod 777|curl .*\|\s*(sh|bash)/);
  });

  it('does not copy secrets or env files into the image', () => {
    const ignore = readFileSync(new URL('../../.dockerignore', import.meta.url), 'utf8');
    for (const entry of ['.env', 'node_modules', '.git'])
      expect(ignore.split('\n')).toContain(entry);
  });
});
