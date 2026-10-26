/**
 * Single-runner leases in PostgreSQL.
 *
 * Several workers may run at once (for availability). Each recurring task
 * claims a named lease before running, so a task never runs twice at the same
 * time. A crashed worker's lease simply expires. Tasks are idempotent, so a
 * task that runs again after an expiry is harmless; the lease only prevents
 * pointless duplicate work and contention.
 *
 * pg-boss was considered (docs/architecture.md). All the work here is
 * poll-driven and idempotent, with no job that must be enqueued atomically
 * with a business change, so a lease table is enough and avoids a dependency
 * that manages its own schema.
 */
import { sql } from 'kysely';
import type { Db } from '@actualpay/database';

export async function acquireLease(
  db: Db,
  name: string,
  owner: string,
  ttlSeconds: number,
): Promise<boolean> {
  await db
    .insertInto('job_leases')
    .values({ name })
    .onConflict((oc) => oc.column('name').doNothing())
    .execute();
  const claimed = await db
    .updateTable('job_leases')
    .set({
      locked_by: owner,
      locked_until: sql<Date>`now() + make_interval(secs => ${ttlSeconds})`,
      last_started_at: sql<Date>`now()`,
      run_count: sql<string>`run_count + 1`,
    })
    .where('name', '=', name)
    .where((eb) =>
      eb.or([eb('locked_until', 'is', null), eb('locked_until', '<', sql<Date>`now()`)]),
    )
    .returning('name')
    .executeTakeFirst();
  return claimed !== undefined;
}

export async function extendLease(
  db: Db,
  name: string,
  owner: string,
  ttlSeconds: number,
): Promise<boolean> {
  const row = await db
    .updateTable('job_leases')
    .set({ locked_until: sql<Date>`now() + make_interval(secs => ${ttlSeconds})` })
    .where('name', '=', name)
    .where('locked_by', '=', owner)
    .returning('name')
    .executeTakeFirst();
  return row !== undefined;
}

export async function releaseLease(
  db: Db,
  name: string,
  owner: string,
  error?: unknown,
): Promise<void> {
  const message =
    error === undefined
      ? null
      : (error instanceof Error ? error.message : JSON.stringify(error)).slice(0, 900);
  await db
    .updateTable('job_leases')
    .set({
      locked_until: sql<Date>`now()`,
      last_finished_at: sql<Date>`now()`,
      last_error: message,
      ...(message ? { last_error_at: sql<Date>`now()` } : {}),
    })
    .where('name', '=', name)
    .where('locked_by', '=', owner)
    .execute();
}

/** Run `fn` if the lease is free; returns `skipped` when another worker holds it. */
export async function runLeased<T>(
  db: Db,
  params: { name: string; owner: string; ttlSeconds: number },
  fn: (heartbeat: () => Promise<void>) => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  if (!(await acquireLease(db, params.name, params.owner, params.ttlSeconds)))
    return { ran: false };
  try {
    const value = await fn(async () => {
      await extendLease(db, params.name, params.owner, params.ttlSeconds);
    });
    await releaseLease(db, params.name, params.owner);
    return { ran: true, value };
  } catch (error) {
    await releaseLease(db, params.name, params.owner, error).catch(() => undefined);
    throw error;
  }
}
