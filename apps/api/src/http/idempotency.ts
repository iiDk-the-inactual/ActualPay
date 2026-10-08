/**
 * `Idempotency-Key` support for organization-scoped POST endpoints.
 *
 * Contract (documented for API clients):
 *  - Same key + same request (method, path, body, caller) within 24 h →
 *    the original response is replayed with `Idempotent-Replayed: true`.
 *  - Same key + different request → 422 IDEMPOTENCY_KEY_REUSED.
 *  - Same key while the first request is still running → 409 CONFLICT.
 *  - If the first attempt failed with a 5xx, the key is released and a
 *    retry executes again.
 *
 * Limitation, stated honestly: the claim and the business transaction are
 * separate commits. If the process dies between them, the claim's lock
 * expires and a retry re-executes. Every money-moving operation is therefore
 * *also* idempotent at the database level (unique ledger references,
 * unique withdrawal request ids); this layer is about clean API semantics.
 */
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { AppError } from '@actualpay/shared';
import type { Db } from '@actualpay/database';

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,255}$/;
const LOCK_SECONDS = 60;
const RETENTION_HOURS = 24;

export interface IdempotencyClaim {
  readonly recordId: string;
}

export type IdempotencyOutcome =
  | { readonly kind: 'proceed'; readonly claim: IdempotencyClaim }
  | { readonly kind: 'replay'; readonly status: number; readonly body: unknown };

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function requestFingerprint(parts: {
  method: string;
  path: string;
  callerId: string;
  body: unknown;
}): string {
  return createHash('sha256')
    .update(`${parts.method}\n${parts.path}\n${parts.callerId}\n${canonicalJson(parts.body)}`)
    .digest('hex');
}

export function validateIdempotencyKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw AppError.validation(
      'Idempotency-Key must be 1–255 characters of letters, digits, "_", "-", ".", ":".',
    );
  }
}

export async function claimIdempotencyKey(
  db: Db,
  params: { organizationId: string; scope: string; key: string; fingerprint: string },
): Promise<IdempotencyOutcome> {
  const inserted = await db
    .insertInto('idempotency_keys')
    .values({
      organization_id: params.organizationId,
      scope: params.scope,
      key: params.key,
      request_hash: params.fingerprint,
      locked_until: sql<Date>`now() + make_interval(secs => ${LOCK_SECONDS})`,
      expires_at: sql<Date>`now() + make_interval(hours => ${RETENTION_HOURS})`,
    })
    .onConflict((oc) => oc.columns(['organization_id', 'scope', 'key']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted) return { kind: 'proceed', claim: { recordId: inserted.id } };

  const existing = await db
    .selectFrom('idempotency_keys')
    .select([
      'id',
      'request_hash',
      'state',
      'response_status',
      'response_body',
      'locked_until',
      'expires_at',
    ])
    .where('organization_id', '=', params.organizationId)
    .where('scope', '=', params.scope)
    .where('key', '=', params.key)
    .executeTakeFirstOrThrow();

  if (existing.expires_at.getTime() <= Date.now()) {
    // Expired record: take it over atomically for this new request.
    const taken = await db
      .updateTable('idempotency_keys')
      .set({
        request_hash: params.fingerprint,
        state: 'in_progress',
        response_status: null,
        response_body: null,
        locked_until: sql`now() + make_interval(secs => ${LOCK_SECONDS})`,
        expires_at: sql`now() + make_interval(hours => ${RETENTION_HOURS})`,
      })
      .where('id', '=', existing.id)
      .where('expires_at', '<=', sql<Date>`now()`)
      .returning('id')
      .executeTakeFirst();
    if (taken) return { kind: 'proceed', claim: { recordId: taken.id } };
    throw AppError.conflict('A request with this Idempotency-Key is already in progress.');
  }

  if (existing.request_hash !== params.fingerprint) {
    throw new AppError(
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used with a different request.',
    );
  }
  if (existing.state === 'completed' && existing.response_status !== null) {
    return { kind: 'replay', status: existing.response_status, body: existing.response_body };
  }
  // In progress: take over only if the previous holder's lock has lapsed.
  const takeover = await db
    .updateTable('idempotency_keys')
    .set({ locked_until: sql`now() + make_interval(secs => ${LOCK_SECONDS})` })
    .where('id', '=', existing.id)
    .where('state', '=', 'in_progress')
    .where((eb) =>
      eb.or([eb('locked_until', 'is', null), eb('locked_until', '<=', sql<Date>`now()`)]),
    )
    .returning('id')
    .executeTakeFirst();
  if (takeover) return { kind: 'proceed', claim: { recordId: takeover.id } };
  throw AppError.conflict('A request with this Idempotency-Key is already in progress.');
}

export async function completeIdempotencyKey(
  db: Db,
  claim: IdempotencyClaim,
  status: number,
  body: unknown,
): Promise<void> {
  if (status >= 500) {
    // Release so the client can retry a server-side failure.
    await db
      .updateTable('idempotency_keys')
      .set({ locked_until: sql`now()` })
      .where('id', '=', claim.recordId)
      .execute();
    return;
  }
  await db
    .updateTable('idempotency_keys')
    .set({
      state: 'completed',
      response_status: status,
      response_body: JSON.stringify(body ?? null),
      locked_until: null,
    })
    .where('id', '=', claim.recordId)
    .execute();
}
