/**
 * Structured logging with mandatory redaction.
 *
 * Redaction is a backstop, not the primary control: code must never pass
 * secrets to the logger in the first place. The censor paths below catch the
 * common mistakes (logging a whole request, a config object or a DB row).
 */
import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

const SENSITIVE_KEYS = [
  'password',
  'passwordHash',
  'newPassword',
  'currentPassword',
  'secret',
  'clientSecret',
  'webhookSecret',
  'apiKey',
  'apiSecret',
  'token',
  'accessToken',
  'refreshToken',
  'sessionToken',
  'privateKey',
  'seed',
  'mnemonic',
  'xprv',
  'encryptionKey',
  'totpSecret',
  'recoveryCodes',
  'authorization',
  'cookie',
  'DATABASE_URL',
  'REDIS_URL',
  'SESSION_SECRET',
  'ENCRYPTION_KEY',
];

/** Build redaction paths for a key at the top level and one/two levels deep. */
function redactionPaths(): string[] {
  const paths: string[] = [];
  for (const key of SENSITIVE_KEYS) {
    paths.push(key, `*.${key}`, `*.*.${key}`);
  }
  paths.push(
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-api-key"]',
    'res.headers["set-cookie"]',
  );
  return paths;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Recursively convert bigint to string in plain objects/arrays only, so
 * Error instances and other class objects reach pino's serializers intact. */
function stringifyBigInts(value: unknown, depth: number): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => stringifyBigInts(item, depth + 1));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = stringifyBigInts(item, depth + 1);
    return out;
  }
  return value;
}

export interface CreateLoggerOptions {
  level: LoggerOptions['level'];
  name: string;
  pretty?: boolean;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  return pino({
    name: options.name,
    level: options.level ?? 'info',
    redact: { paths: redactionPaths(), censor: '[REDACTED]' },
    // Amounts are bigint. Pino would emit them as bare JSON numbers, which most
    // log pipelines parse as floats and silently round. Emit exact strings.
    formatters: {
      log(object) {
        return stringifyBigInts(object, 0) as Record<string, unknown>;
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
