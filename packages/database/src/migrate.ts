/**
 * Schema migrations and asset-registry synchronisation.
 *
 * Kysely's migrator takes a PostgreSQL advisory lock, so two containers
 * starting at once cannot run migrations concurrently.
 */
import { Migrator, type MigrationResultSet } from 'kysely/migration';
import { ASSETS, type AssetDefinition } from '@actualpay/shared';
import type { Db } from './client';
import { migrations } from './migrations/index';

export function createMigrator(db: Db): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
  });
}

export async function migrateToLatest(db: Db): Promise<MigrationResultSet> {
  const result = await createMigrator(db).migrateToLatest();
  if (result.error !== undefined) {
    throw result.error instanceof Error
      ? result.error
      : new Error('Migration failed', { cause: result.error });
  }
  await syncAssets(db);
  return result;
}

/**
 * Insert any assets from the registry that are missing. Existing rows are
 * compared, not overwritten: a mismatch means the code and the database
 * disagree about a protocol fact (e.g. decimals) and must be investigated by
 * a human, because every stored amount depends on it.
 */
export async function syncAssets(db: Db): Promise<void> {
  await db.transaction().execute(async (tx) => {
    for (const asset of Object.values(ASSETS)) {
      await tx
        .insertInto('assets')
        .values({
          id: asset.id,
          chain: asset.chain,
          symbol: asset.symbol,
          kind: asset.kind,
          decimals: asset.decimals,
          fee_asset_id: asset.feeAssetId,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    }
    const rows = await tx.selectFrom('assets').selectAll().execute();
    for (const row of rows) {
      const registry: Partial<Record<string, AssetDefinition>> = ASSETS;
      const expected = registry[row.id];
      if (!expected) continue; // Retired from the registry; keep the row for history.
      if (
        row.decimals !== expected.decimals ||
        row.chain !== expected.chain ||
        row.kind !== expected.kind ||
        row.fee_asset_id !== expected.feeAssetId
      ) {
        throw new Error(
          `Asset "${row.id}" in the database does not match the code registry. ` +
            'Refusing to continue; this must be resolved manually.',
        );
      }
    }
  });
}
