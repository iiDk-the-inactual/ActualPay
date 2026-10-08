/**
 * Audit trail writer.
 *
 * Call `recordAudit` inside the same transaction as the change being audited,
 * so a change can never commit without its audit record (and an audit record
 * never exists for a change that rolled back).
 */
import type { Db } from '@actualpay/database';

export type AuditActor =
  | { readonly type: 'user'; readonly id: string }
  | { readonly type: 'api_key'; readonly id: string }
  | { readonly type: 'system' };

/** Request facts attached to every audit record. */
export interface RequestMeta {
  readonly requestId?: string;
  readonly ip?: string;
  readonly userAgent?: string;
}

export interface AuditEntry {
  readonly actor: AuditActor;
  readonly action: string;
  readonly organizationId?: string | null;
  readonly target?: { readonly type: string; readonly id: string };
  readonly meta?: RequestMeta;
  readonly metadata?: Record<string, unknown>;
}

const SECRET_KEY_PATTERN =
  /(password|secret|token|private|seed|mnemonic|recovery|otp|code_hash|cookie|authorization)/i;
const MAX_METADATA_BYTES = 8_192;

/**
 * Defence in depth: even if a caller passes something sensitive, it is
 * replaced before it reaches the immutable audit table (which cannot be
 * cleaned up afterwards).
 */
export function sanitizeAuditMetadata(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[TRUNCATED]';
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => sanitizeAuditMetadata(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY_PATTERN.test(key)
        ? '[REDACTED]'
        : sanitizeAuditMetadata(item, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  let metadata = JSON.stringify(sanitizeAuditMetadata(entry.metadata ?? {}));
  if (Buffer.byteLength(metadata) > MAX_METADATA_BYTES)
    metadata = JSON.stringify({ truncated: true });
  await db
    .insertInto('audit_log')
    .values({
      actor_type: entry.actor.type,
      actor_id: entry.actor.type === 'system' ? null : entry.actor.id,
      organization_id: entry.organizationId ?? null,
      action: entry.action,
      target_type: entry.target?.type ?? null,
      target_id: entry.target?.id ?? null,
      request_id: entry.meta?.requestId?.slice(0, 100) ?? null,
      ip_address: entry.meta?.ip ?? null,
      user_agent: entry.meta?.userAgent?.slice(0, 512) ?? null,
      metadata,
    })
    .execute();
}
