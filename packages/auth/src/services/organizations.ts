/**
 * Organizations, memberships and invitations.
 *
 * Authorization rules that are not plain permissions live here so every
 * caller (API, CLI, future admin tools) enforces them identically:
 *   - only owners may grant, change or remove the owner role;
 *   - every organization keeps at least one owner (also a DB constraint);
 *   - non-members get NOT_FOUND, never FORBIDDEN, so organization ids
 *     cannot be probed for existence.
 */
import { sql } from 'kysely';
import { AppError } from '@actualpay/shared';
import { asPgError, inTransaction, PG_ERRORS, type Db, type OrgRole } from '@actualpay/database';
import { recordAudit, type AuditActor, type RequestMeta } from '@actualpay/audit';
import { invitationEmail, sendSafely } from '@actualpay/email';
import { randomAlphanumeric, randomToken, sha256Hex } from '../crypto';
import { normalizeEmail } from '../email-address';
import { ROLE_PERMISSIONS, type Permission } from '../rbac';
import { appLink, type AuthDeps } from './deps';

export interface OrgAccess {
  readonly organizationId: string;
  readonly organizationStatus: 'active' | 'suspended';
  readonly role: OrgRole | null;
  readonly permissions: ReadonlySet<Permission>;
}

export async function resolveMemberAccess(
  db: Db,
  organizationId: string,
  userId: string,
): Promise<OrgAccess | null> {
  const row = await db
    .selectFrom('organization_members as m')
    .innerJoin('organizations as o', 'o.id', 'm.organization_id')
    .select(['m.role', 'o.status'])
    .where('m.organization_id', '=', organizationId)
    .where('m.user_id', '=', userId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    organizationId,
    organizationStatus: row.status,
    role: row.role,
    permissions: ROLE_PERMISSIONS[row.role],
  };
}

function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base.length >= 3 ? base : `org-${base}`.replace(/-+$/, '');
}

export async function createOrganization(
  deps: Pick<AuthDeps, 'db'>,
  params: { userId: string; name: string; slug?: string },
  meta: RequestMeta,
): Promise<{ id: string; slug: string; name: string }> {
  const name = params.name.trim();
  if (name.length < 1 || name.length > 200)
    throw AppError.validation('Organization name must be 1–200 characters.');
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug =
      params.slug ??
      (attempt === 0
        ? slugify(name)
        : `${slugify(name).slice(0, 33)}-${randomAlphanumeric(6).toLowerCase()}`);
    try {
      return await inTransaction(deps.db, async (tx) => {
        const org = await tx
          .insertInto('organizations')
          .values({ slug, name })
          .returning(['id', 'slug', 'name'])
          .executeTakeFirstOrThrow();
        await tx
          .insertInto('organization_members')
          .values({ organization_id: org.id, user_id: params.userId, role: 'owner' })
          .execute();
        await recordAudit(tx, {
          actor: { type: 'user', id: params.userId },
          action: 'org.created',
          organizationId: org.id,
          target: { type: 'organization', id: org.id },
          meta,
          metadata: { slug: org.slug },
        });
        return org;
      });
    } catch (error) {
      const pg = asPgError(error);
      if (pg?.code === PG_ERRORS.UNIQUE_VIOLATION && pg.constraint === 'organizations_slug_key') {
        if (params.slug) throw AppError.conflict('This organization slug is already taken.');
        continue;
      }
      if (pg?.code === PG_ERRORS.CHECK_VIOLATION)
        throw AppError.validation('Invalid organization slug.');
      throw error;
    }
  }
  throw AppError.conflict('Could not allocate a unique organization slug; provide one explicitly.');
}

export async function listOrganizationsForUser(db: Db, userId: string) {
  return db
    .selectFrom('organization_members as m')
    .innerJoin('organizations as o', 'o.id', 'm.organization_id')
    .select(['o.id', 'o.slug', 'o.name', 'o.status', 'o.created_at', 'm.role'])
    .where('m.user_id', '=', userId)
    .orderBy('o.created_at')
    .limit(200)
    .execute();
}

export async function getOrganization(db: Db, organizationId: string) {
  return db
    .selectFrom('organizations')
    .select(['id', 'slug', 'name', 'status', 'created_at'])
    .where('id', '=', organizationId)
    .executeTakeFirstOrThrow();
}

export async function updateOrganization(
  db: Db,
  params: { organizationId: string; name: string; actor: AuditActor },
  meta: RequestMeta,
) {
  const name = params.name.trim();
  if (name.length < 1 || name.length > 200)
    throw AppError.validation('Organization name must be 1–200 characters.');
  return inTransaction(db, async (tx) => {
    const before = await tx
      .selectFrom('organizations')
      .select('name')
      .where('id', '=', params.organizationId)
      .executeTakeFirstOrThrow();
    const row = await tx
      .updateTable('organizations')
      .set({ name })
      .where('id', '=', params.organizationId)
      .returning(['id', 'slug', 'name', 'status', 'created_at'])
      .executeTakeFirstOrThrow();
    await recordAudit(tx, {
      actor: params.actor,
      action: 'org.updated',
      organizationId: params.organizationId,
      target: { type: 'organization', id: params.organizationId },
      meta,
      metadata: { from: before.name, to: name },
    });
    return row;
  });
}

export async function listMembers(db: Db, organizationId: string) {
  return db
    .selectFrom('organization_members as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select([
      'u.id as userId',
      'u.email',
      'u.display_name as displayName',
      'm.role',
      'm.created_at as joinedAt',
    ])
    .where('m.organization_id', '=', organizationId)
    .orderBy('m.created_at')
    .limit(500)
    .execute();
}

/** Owner-only safeguard shared by role changes, removals and invitations. */
export function assertMayAssign(
  actorRole: OrgRole,
  targetCurrentRole: OrgRole | null,
  targetNewRole: OrgRole | null,
): void {
  const touchesOwner = targetCurrentRole === 'owner' || targetNewRole === 'owner';
  if (touchesOwner && actorRole !== 'owner')
    throw AppError.forbidden('Only owners can grant, change or remove the owner role.');
}

function mapOwnerConstraint(error: unknown): never {
  const pg = asPgError(error);
  if (pg?.code === PG_ERRORS.CHECK_VIOLATION && pg.constraint === 'organization_must_have_owner') {
    throw AppError.conflict('An organization must keep at least one owner.');
  }
  throw error;
}

export async function changeMemberRole(
  db: Db,
  params: {
    organizationId: string;
    actorUserId: string;
    actorRole: OrgRole;
    targetUserId: string;
    newRole: OrgRole;
  },
  meta: RequestMeta,
): Promise<void> {
  try {
    await inTransaction(db, async (tx) => {
      const target = await tx
        .selectFrom('organization_members')
        .select('role')
        .where('organization_id', '=', params.organizationId)
        .where('user_id', '=', params.targetUserId)
        .forUpdate()
        .executeTakeFirst();
      if (!target) throw AppError.notFound('Member');
      assertMayAssign(params.actorRole, target.role, params.newRole);
      if (target.role === params.newRole) return;
      await tx
        .updateTable('organization_members')
        .set({ role: params.newRole })
        .where('organization_id', '=', params.organizationId)
        .where('user_id', '=', params.targetUserId)
        .execute();
      await recordAudit(tx, {
        actor: { type: 'user', id: params.actorUserId },
        action: 'org.member.role_changed',
        organizationId: params.organizationId,
        target: { type: 'user', id: params.targetUserId },
        meta,
        metadata: { from: target.role, to: params.newRole },
      });
    });
  } catch (error) {
    mapOwnerConstraint(error);
  }
}

export async function removeMember(
  db: Db,
  params: { organizationId: string; actorUserId: string; actorRole: OrgRole; targetUserId: string },
  meta: RequestMeta,
): Promise<void> {
  try {
    await inTransaction(db, async (tx) => {
      const target = await tx
        .selectFrom('organization_members')
        .select('role')
        .where('organization_id', '=', params.organizationId)
        .where('user_id', '=', params.targetUserId)
        .forUpdate()
        .executeTakeFirst();
      if (!target) throw AppError.notFound('Member');
      // Leaving voluntarily is always allowed (subject to the last-owner rule).
      if (params.targetUserId !== params.actorUserId)
        assertMayAssign(params.actorRole, target.role, null);
      await tx
        .deleteFrom('organization_members')
        .where('organization_id', '=', params.organizationId)
        .where('user_id', '=', params.targetUserId)
        .execute();
      await recordAudit(tx, {
        actor: { type: 'user', id: params.actorUserId },
        action:
          params.targetUserId === params.actorUserId ? 'org.member.left' : 'org.member.removed',
        organizationId: params.organizationId,
        target: { type: 'user', id: params.targetUserId },
        meta,
        metadata: { role: target.role },
      });
    });
  } catch (error) {
    mapOwnerConstraint(error);
  }
}

const INVITATION_TTL_DAYS = 7;

export async function createInvitation(
  deps: AuthDeps,
  params: {
    organizationId: string;
    actorUserId: string;
    actorRole: OrgRole;
    email: string;
    role: OrgRole;
  },
  meta: RequestMeta,
): Promise<{ id: string; email: string; role: OrgRole; expiresAt: Date }> {
  const email = normalizeEmail(params.email);
  assertMayAssign(params.actorRole, null, params.role);
  const token = randomToken(32);
  const result = await inTransaction(deps.db, async (tx) => {
    const alreadyMember = await tx
      .selectFrom('organization_members as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select('u.id')
      .where('m.organization_id', '=', params.organizationId)
      .where('u.email', '=', email)
      .executeTakeFirst();
    if (alreadyMember) throw AppError.conflict('This person is already a member.');
    // A new invitation replaces any pending one for the same email.
    await tx
      .updateTable('organization_invitations')
      .set({ revoked_at: sql`now()` })
      .where('organization_id', '=', params.organizationId)
      .where('email', '=', email)
      .where('accepted_at', 'is', null)
      .where('revoked_at', 'is', null)
      .execute();
    const row = await tx
      .insertInto('organization_invitations')
      .values({
        organization_id: params.organizationId,
        email,
        role: params.role,
        token_hash: sha256Hex(token),
        invited_by: params.actorUserId,
        expires_at: sql<Date>`now() + make_interval(days => ${INVITATION_TTL_DAYS})`,
      })
      .returning(['id', 'email', 'role', 'expires_at'])
      .executeTakeFirstOrThrow();
    await recordAudit(tx, {
      actor: { type: 'user', id: params.actorUserId },
      action: 'org.invitation.created',
      organizationId: params.organizationId,
      target: { type: 'invitation', id: row.id },
      meta,
      metadata: { email, role: params.role },
    });
    const org = await tx
      .selectFrom('organizations')
      .select('name')
      .where('id', '=', params.organizationId)
      .executeTakeFirstOrThrow();
    return { row, organizationName: org.name };
  });
  await sendSafely(
    deps.mailer,
    invitationEmail({
      to: email,
      appName: deps.appName,
      organizationName: result.organizationName,
      role: params.role,
      link: appLink(deps, '/accept-invitation', token),
    }),
    deps.logger,
  );
  return {
    id: result.row.id,
    email: result.row.email,
    role: result.row.role,
    expiresAt: result.row.expires_at,
  };
}

export async function listInvitations(db: Db, organizationId: string) {
  return db
    .selectFrom('organization_invitations')
    .select(['id', 'email', 'role', 'created_at', 'expires_at'])
    .where('organization_id', '=', organizationId)
    .where('accepted_at', 'is', null)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .orderBy('created_at', 'desc')
    .limit(200)
    .execute();
}

export async function revokeInvitation(
  db: Db,
  params: { organizationId: string; invitationId: string; actorUserId: string; actorRole: OrgRole },
  meta: RequestMeta,
): Promise<void> {
  await inTransaction(db, async (tx) => {
    const invitation = await tx
      .selectFrom('organization_invitations')
      .select(['role'])
      .where('id', '=', params.invitationId)
      .where('organization_id', '=', params.organizationId) // scoping prevents cross-org revocation
      .where('accepted_at', 'is', null)
      .where('revoked_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!invitation) throw AppError.notFound('Invitation');
    assertMayAssign(params.actorRole, null, invitation.role);
    await tx
      .updateTable('organization_invitations')
      .set({ revoked_at: sql`now()` })
      .where('id', '=', params.invitationId)
      .execute();
    await recordAudit(tx, {
      actor: { type: 'user', id: params.actorUserId },
      action: 'org.invitation.revoked',
      organizationId: params.organizationId,
      target: { type: 'invitation', id: params.invitationId },
      meta,
    });
  });
}

/**
 * Accept an invitation as the signed-in user. The user's verified email must
 * match the invited address, so a forwarded or leaked link cannot be used by
 * someone else.
 */
export async function acceptInvitation(
  db: Db,
  params: { userId: string; token: string },
  meta: RequestMeta,
): Promise<{ organizationId: string; role: OrgRole }> {
  if (params.token.length < 20 || params.token.length > 100)
    throw AppError.validation('This invitation is invalid or has expired.');
  return inTransaction(db, async (tx) => {
    const user = await tx
      .selectFrom('users')
      .select(['email', 'email_verified_at'])
      .where('id', '=', params.userId)
      .executeTakeFirstOrThrow();
    const invitation = await tx
      .selectFrom('organization_invitations')
      .select(['id', 'organization_id', 'email', 'role'])
      .where('token_hash', '=', sha256Hex(params.token))
      .where('accepted_at', 'is', null)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .forUpdate()
      .executeTakeFirst();
    if (!invitation || invitation.email !== user.email || user.email_verified_at === null) {
      // Same error whether the token is wrong or belongs to someone else.
      throw AppError.validation('This invitation is invalid or has expired.');
    }
    await tx
      .insertInto('organization_members')
      .values({
        organization_id: invitation.organization_id,
        user_id: params.userId,
        role: invitation.role,
      })
      .onConflict((oc) => oc.columns(['organization_id', 'user_id']).doNothing())
      .execute();
    await tx
      .updateTable('organization_invitations')
      .set({ accepted_at: sql`now()`, accepted_by: params.userId })
      .where('id', '=', invitation.id)
      .execute();
    await recordAudit(tx, {
      actor: { type: 'user', id: params.userId },
      action: 'org.invitation.accepted',
      organizationId: invitation.organization_id,
      target: { type: 'invitation', id: invitation.id },
      meta,
      metadata: { role: invitation.role },
    });
    return { organizationId: invitation.organization_id, role: invitation.role };
  });
}
