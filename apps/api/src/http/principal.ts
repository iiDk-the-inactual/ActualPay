/**
 * Who is making the request. Exactly one of: a browser session (cookie) or
 * an organization API key (Authorization: Bearer). Never both.
 */
import type { ApiKeyPrincipal, SessionPrincipal } from '@actualpay/auth';
import type { AuditActor } from '@actualpay/audit';

export type Principal =
  | { readonly kind: 'session'; readonly session: SessionPrincipal }
  | { readonly kind: 'api_key'; readonly key: ApiKeyPrincipal };

export function auditActor(principal: Principal): AuditActor {
  return principal.kind === 'session'
    ? { type: 'user', id: principal.session.userId }
    : { type: 'api_key', id: principal.key.apiKeyId };
}

/** Cookie name. `__Host-` forces Secure, Path=/ and no Domain in browsers. */
export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-ap_session' : 'ap_session';
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}
