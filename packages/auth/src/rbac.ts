/**
 * Role-based access control.
 *
 * Permissions are fine-grained strings checked by the backend on every
 * request; roles are named bundles of permissions. Adding a role means adding
 * an entry here (and to the database CHECK list); no route code changes.
 *
 * Permissions for features delivered in later phases are declared now so
 * that roles and API key scopes are stable from the first release.
 */
import type { OrgRole } from '@actualpay/database';

export const PERMISSIONS = [
  'org:read',
  'org:update',
  'member:read',
  'member:manage',
  'apikey:read',
  'apikey:manage',
  'audit:read',
  'invoice:read',
  'invoice:create',
  'invoice:cancel',
  'payment:read',
  'wallet:read',
  'wallet:manage',
  'ledger:read',
  'withdrawal:read',
  'withdrawal:create',
  'withdrawal:approve',
  'webhook:read',
  'webhook:manage',
  'settings:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ORG_ROLES = [
  'owner',
  'admin',
  'finance',
  'developer',
  'viewer',
] as const satisfies readonly OrgRole[];

const READ_ONLY: readonly Permission[] = [
  'org:read',
  'member:read',
  'invoice:read',
  'payment:read',
  'wallet:read',
  'ledger:read',
  'withdrawal:read',
  'webhook:read',
];

export const ROLE_PERMISSIONS: Readonly<Record<OrgRole, ReadonlySet<Permission>>> = {
  owner: new Set(PERMISSIONS),
  // Admins can do everything operational; owner-only safeguards (managing
  // owners) are enforced in the membership rules, not by permission.
  admin: new Set(PERMISSIONS),
  finance: new Set<Permission>([
    ...READ_ONLY,
    'audit:read',
    'invoice:create',
    'invoice:cancel',
    'withdrawal:create',
  ]),
  developer: new Set<Permission>([
    ...READ_ONLY,
    'apikey:read',
    'apikey:manage',
    'webhook:manage',
    'invoice:create',
  ]),
  viewer: new Set<Permission>(READ_ONLY),
};

/**
 * Permissions an API key may carry. Organization administration (members,
 * keys, settings, approvals) is deliberately session-only: a leaked
 * integration key must not be able to add users or mint more keys.
 */
export const API_KEY_SCOPES = [
  'invoice:read',
  'invoice:create',
  'invoice:cancel',
  'payment:read',
  'wallet:read',
  'ledger:read',
  'withdrawal:read',
  'withdrawal:create',
  'webhook:read',
  'webhook:manage',
] as const satisfies readonly Permission[];
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Scopes that can move money; creating keys with them requires extra assurance. */
export const HIGH_RISK_SCOPES: ReadonlySet<ApiKeyScope> = new Set(['withdrawal:create']);

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value);
}

export function roleHas(role: OrgRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === 'string' && (API_KEY_SCOPES as readonly string[]).includes(value);
}
