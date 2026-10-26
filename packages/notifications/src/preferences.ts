import type { Db, NotificationKind } from '@actualpay/database';
import { AppError } from '@actualpay/shared';
import { KIND_INFO, NOTIFICATION_KINDS, isNotificationKind } from './kinds';

export interface PreferenceView {
  readonly kind: NotificationKind;
  readonly label: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  /** False when the member's role never receives this kind. */
  readonly applicable: boolean;
}

export async function listPreferences(
  db: Db,
  params: { userId: string; organizationId: string; role: string },
): Promise<PreferenceView[]> {
  const rows = await db
    .selectFrom('notification_preferences')
    .select(['kind', 'enabled'])
    .where('user_id', '=', params.userId)
    .where('organization_id', '=', params.organizationId)
    .execute();
  const set = new Map(rows.map((r) => [r.kind, r.enabled] as const));
  return NOTIFICATION_KINDS.map((kind) => {
    const info = KIND_INFO[kind];
    const explicit = set.get(kind);
    return {
      kind,
      label: info.label,
      enabled: explicit ?? info.defaultOn,
      isDefault: explicit === undefined,
      applicable: (info.roles as readonly string[]).includes(params.role),
    };
  });
}

export async function setPreference(
  db: Db,
  params: { userId: string; organizationId: string; kind: string; enabled: boolean },
): Promise<void> {
  if (!isNotificationKind(params.kind)) throw AppError.validation('Unknown notification kind.');
  await db
    .insertInto('notification_preferences')
    .values({
      user_id: params.userId,
      organization_id: params.organizationId,
      kind: params.kind,
      enabled: params.enabled,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'organization_id', 'kind']).doUpdateSet({ enabled: params.enabled }),
    )
    .execute();
}
