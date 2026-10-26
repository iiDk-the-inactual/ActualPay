/** The platform-wide pause switch for withdrawals (the kill switch). */
import { inTransaction, type Db, type Tx } from '@actualpay/database';
import { recordAudit, type RequestMeta } from '@actualpay/audit';

export async function withdrawalsPaused(
  db: Db | Tx,
): Promise<{ paused: boolean; reason: string | null }> {
  const row = await db
    .selectFrom('platform_settings')
    .select(['withdrawals_paused', 'pause_reason'])
    .executeTakeFirstOrThrow();
  return { paused: row.withdrawals_paused, reason: row.pause_reason };
}

/**
 * Stop (or resume) all withdrawals. While paused, no withdrawal can be
 * requested or approved, and the signer refuses to sign. In-flight
 * transactions that were already signed still finish.
 */
export async function setWithdrawalsPaused(
  db: Db,
  params: { paused: boolean; reason?: string; userId: string },
  meta: RequestMeta,
): Promise<void> {
  await inTransaction(db, async (tx) => {
    await tx
      .updateTable('platform_settings')
      .set({
        withdrawals_paused: params.paused,
        pause_reason: params.paused
          ? (params.reason?.slice(0, 500) ?? 'Paused by an administrator.')
          : null,
        updated_by: params.userId,
        updated_at: new Date(),
      })
      .where('id', '=', true)
      .execute();
    await recordAudit(tx, {
      actor: { type: 'user', id: params.userId },
      action: params.paused ? 'platform.withdrawals_paused' : 'platform.withdrawals_resumed',
      target: { type: 'platform_settings', id: 'global' },
      meta,
      metadata: { reason: params.reason ?? null },
    });
  });
}
