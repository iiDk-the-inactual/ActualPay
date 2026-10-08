/**
 * Organization API keys.
 *
 * Rules:
 *  - the full key is returned exactly once, at creation/rotation;
 *  - a key's scopes must be a subset of the creator's own permissions, so
 *    creating a key can never escalate privilege;
 *  - money-moving scopes (withdrawal:create) require an owner/admin whose
 *    current session passed two-factor authentication;
 *  - keys are revoked, never deleted, so audit history stays meaningful.
 */
import { sql } from 'kysely';
import { AppError, type NetworkMode } from '@actualpay/shared';
import { inTransaction, type Db, type OrgRole } from '@actualpay/database';
import { recordAudit, type RequestMeta } from '@actualpay/audit';
import { generateApiKey, modeFor, parseApiKey } from '../api-key-format';
import { safeEqual } from '../crypto';
import { HIGH_RISK_SCOPES, isApiKeyScope, ROLE_PERMISSIONS, type ApiKeyScope } from '../rbac';

export const API_KEY_MAX_LIFETIME_DAYS = 730;
export const API_KEY_MAX_ROTATION_GRACE_HOURS = 168;

export interface ApiKeyCreator {
  readonly userId: string;
  readonly role: OrgRole;
  readonly mfaVerified: boolean;
}

export interface ApiKeyPrincipal {
  readonly apiKeyId: string;
  readonly organizationId: string;
  readonly scopes: ReadonlySet<ApiKeyScope>;
}

function validateScopes(creator: ApiKeyCreator, requested: readonly string[]): ApiKeyScope[] {
  const unique = [...new Set(requested)];
  if (unique.length === 0) throw AppError.validation('At least one scope is required.');
  const scopes: ApiKeyScope[] = [];
  for (const scope of unique) {
    if (!isApiKeyScope(scope))
      throw AppError.validation(`Unknown or non-delegable scope: ${scope}`);
    if (!ROLE_PERMISSIONS[creator.role].has(scope))
      throw AppError.forbidden(`You cannot grant a scope you do not have: ${scope}`);
    if (HIGH_RISK_SCOPES.has(scope)) {
      if (creator.role !== 'owner' && creator.role !== 'admin')
        throw AppError.forbidden(`Only owners and admins can create keys with ${scope}.`);
      if (!creator.mfaVerified)
        throw new AppError(
          'MFA_REQUIRED',
          `Creating a key with ${scope} requires a session verified with two-factor authentication.`,
        );
    }
    scopes.push(scope);
  }
  return scopes.sort();
}

function validateExpiry(expiresAt: Date | undefined): Date | null {
  if (!expiresAt) return null;
  const ms = expiresAt.getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 60_000)
    throw AppError.validation('expiresAt must be in the future.');
  if (ms > API_KEY_MAX_LIFETIME_DAYS * 86_400_000)
    throw AppError.validation(`expiresAt must be within ${API_KEY_MAX_LIFETIME_DAYS} days.`);
  return expiresAt;
}

export async function createApiKey(
  db: Db,
  params: {
    organizationId: string;
    network: NetworkMode;
    creator: ApiKeyCreator;
    name: string;
    scopes: readonly string[];
    expiresAt?: Date;
  },
  meta: RequestMeta,
): Promise<{ id: string; key: string; publicId: string }> {
  const name = params.name.trim();
  if (name.length < 1 || name.length > 100)
    throw AppError.validation('Key name must be 1–100 characters.');
  const scopes = validateScopes(params.creator, params.scopes);
  const expiresAt = validateExpiry(params.expiresAt);
  const generated = generateApiKey(params.network);
  return inTransaction(db, async (tx) => {
    const row = await tx
      .insertInto('api_keys')
      .values({
        organization_id: params.organizationId,
        public_id: generated.publicId,
        secret_hash: generated.secretHash,
        name,
        scopes,
        created_by: params.creator.userId,
        expires_at: expiresAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await recordAudit(tx, {
      actor: { type: 'user', id: params.creator.userId },
      action: 'org.api_key.created',
      organizationId: params.organizationId,
      target: { type: 'api_key', id: row.id },
      meta,
      metadata: {
        name,
        scopes,
        publicId: generated.publicId,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    });
    return { id: row.id, key: generated.key, publicId: generated.publicId };
  });
}

export async function listApiKeys(db: Db, organizationId: string) {
  return db
    .selectFrom('api_keys')
    .select([
      'id',
      'public_id',
      'name',
      'scopes',
      'created_by',
      'created_at',
      'expires_at',
      'revoked_at',
      'last_used_at',
      'rotated_from_id',
    ])
    .where('organization_id', '=', organizationId)
    .orderBy('created_at', 'desc')
    .limit(500)
    .execute();
}

export async function revokeApiKey(
  db: Db,
  params: { organizationId: string; apiKeyId: string; actorUserId: string },
  meta: RequestMeta,
): Promise<void> {
  await inTransaction(db, async (tx) => {
    const result = await tx
      .updateTable('api_keys')
      .set({ revoked_at: sql`now()`, revoked_by: params.actorUserId })
      .where('id', '=', params.apiKeyId)
      .where('organization_id', '=', params.organizationId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw AppError.notFound('API key');
    await recordAudit(tx, {
      actor: { type: 'user', id: params.actorUserId },
      action: 'org.api_key.revoked',
      organizationId: params.organizationId,
      target: { type: 'api_key', id: params.apiKeyId },
      meta,
    });
  });
}

/**
 * Issue a replacement key with the same name and scopes. The old key keeps
 * working for `graceHours` (0 = revoke immediately) so integrations can be
 * redeployed without downtime. The creator must still hold every scope.
 */
export async function rotateApiKey(
  db: Db,
  params: {
    organizationId: string;
    network: NetworkMode;
    apiKeyId: string;
    creator: ApiKeyCreator;
    graceHours: number;
  },
  meta: RequestMeta,
): Promise<{ id: string; key: string; publicId: string; oldKeyExpiresAt: Date | null }> {
  if (
    !Number.isInteger(params.graceHours) ||
    params.graceHours < 0 ||
    params.graceHours > API_KEY_MAX_ROTATION_GRACE_HOURS
  ) {
    throw AppError.validation(
      `graceHours must be an integer between 0 and ${API_KEY_MAX_ROTATION_GRACE_HOURS}.`,
    );
  }
  return inTransaction(db, async (tx) => {
    const old = await tx
      .selectFrom('api_keys')
      .select(['id', 'name', 'scopes', 'expires_at'])
      .where('id', '=', params.apiKeyId)
      .where('organization_id', '=', params.organizationId)
      .where('revoked_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!old) throw AppError.notFound('API key');
    const scopes = validateScopes(params.creator, old.scopes);
    const generated = generateApiKey(params.network);
    const created = await tx
      .insertInto('api_keys')
      .values({
        organization_id: params.organizationId,
        public_id: generated.publicId,
        secret_hash: generated.secretHash,
        name: old.name,
        scopes,
        created_by: params.creator.userId,
        expires_at: old.expires_at,
        rotated_from_id: old.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    let oldKeyExpiresAt: Date | null = null;
    if (params.graceHours === 0) {
      await tx
        .updateTable('api_keys')
        .set({ revoked_at: sql`now()`, revoked_by: params.creator.userId })
        .where('id', '=', old.id)
        .execute();
    } else {
      const updated = await tx
        .updateTable('api_keys')
        .set({
          expires_at: sql`LEAST(COALESCE(expires_at, 'infinity'::timestamptz), now() + make_interval(hours => ${params.graceHours}))`,
        })
        .where('id', '=', old.id)
        .returning('expires_at')
        .executeTakeFirstOrThrow();
      oldKeyExpiresAt = updated.expires_at;
    }
    await recordAudit(tx, {
      actor: { type: 'user', id: params.creator.userId },
      action: 'org.api_key.rotated',
      organizationId: params.organizationId,
      target: { type: 'api_key', id: old.id },
      meta,
      metadata: { replacementId: created.id, graceHours: params.graceHours },
    });
    return { id: created.id, key: generated.key, publicId: generated.publicId, oldKeyExpiresAt };
  });
}

/**
 * Authenticate a presented key. Returns null for every failure mode (bad
 * format, wrong network, unknown, wrong secret, revoked, expired) so callers
 * cannot distinguish them.
 */
export async function authenticateApiKey(
  db: Db,
  network: NetworkMode,
  presented: string,
  ip: string | undefined,
): Promise<ApiKeyPrincipal | null> {
  const parsed = parseApiKey(presented);
  if (!parsed || parsed.mode !== modeFor(network)) return null;
  const row = await db
    .selectFrom('api_keys')
    .select([
      'id',
      'organization_id',
      'secret_hash',
      'scopes',
      'revoked_at',
      'expires_at',
      'last_used_at',
    ])
    .where('public_id', '=', parsed.publicId)
    .executeTakeFirst();
  if (!row) return null;
  if (!safeEqual(row.secret_hash, parsed.secretHash)) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) return null;

  if (row.last_used_at === null || Date.now() - row.last_used_at.getTime() > 60_000) {
    await db
      .updateTable('api_keys')
      .set({ last_used_at: sql`now()`, last_used_ip: ip ?? null })
      .where('id', '=', row.id)
      .execute();
  }
  return {
    apiKeyId: row.id,
    organizationId: row.organization_id,
    scopes: new Set(row.scopes.filter(isApiKeyScope)),
  };
}
