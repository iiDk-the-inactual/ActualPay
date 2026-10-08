/** Reusable request/response schemas. */
import { z } from 'zod';
import { API_KEY_SCOPES, ORG_ROLES } from '@actualpay/auth';

export const uuid = z.string().uuid();
export const orgParams = z.object({ orgId: uuid });
export const emailInput = z.string().trim().min(3).max(254);
export const passwordInput = z.string().min(1).max(1024); // policy enforced by the service
export const tokenInput = z.string().min(20).max(100);
export const codeInput = z.string().trim().min(6).max(32);
export const roleSchema = z.enum(ORG_ROLES);
export const scopeSchema = z.enum(API_KEY_SCOPES);
export const isoDate = z.date().transform((d) => d.toISOString());
export const nullableIsoDate = z
  .date()
  .nullable()
  .transform((d) => (d ? d.toISOString() : null));
export const empty = z.null();

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  emailVerified: z.boolean(),
  isPlatformAdmin: z.boolean(),
});

export const organizationSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  status: z.enum(['active', 'suspended']),
  createdAt: isoDate,
});
