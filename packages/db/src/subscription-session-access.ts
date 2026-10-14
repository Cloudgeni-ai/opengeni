import { sql } from "drizzle-orm";
import { rawRows, type Database } from "./database";

/**
 * Run `fn` in the trusted service scope (no subject, no initiating human) of
 * an open, workspace-scoped transaction, then restore both settings.
 *
 * Used only to wake a shared (workspace or organization) pool's capacity
 * waiters after the caller's own subject has resolved that pool. Waking is
 * durable invalidation: it bumps the waiter's wake revision and enqueues a
 * workflow wake, and each waiter then rechecks its own immutable pool. This is
 * the Codex rule: Codex waiters are woken in the same service scope. Under a
 * member's subject, FORCE RLS would hide every other member's `user_private`
 * waiter, which then waited for its periodic recheck. `fn` must stay limited
 * to the exact pool scope and must not return session rows or ids to the
 * caller, so the caller gains no read access to another member's session.
 */
export async function withPoolWakeServiceScopeInTransaction<T>(
  tx: Database,
  fn: () => Promise<T>,
): Promise<T> {
  const [prior] = await rawRows<{
    subject_id: string | null;
    initiating_human_subject_id: string | null;
  }>(
    tx,
    sql`select current_setting('opengeni.subject_id', true) as subject_id,
      current_setting('opengeni.initiating_human_subject_id', true) as initiating_human_subject_id`,
  );
  await tx.execute(
    sql`select set_config('opengeni.subject_id', '', true), set_config('opengeni.initiating_human_subject_id', '', true)`,
  );
  const restore = async () =>
    await tx.execute(
      sql`select set_config('opengeni.subject_id', ${prior?.subject_id ?? ""}, true), set_config('opengeni.initiating_human_subject_id', ${prior?.initiating_human_subject_id ?? ""}, true)`,
    );
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    // An aborted transaction cannot run the restore; the setting dies with it.
    await restore().catch(() => undefined);
    throw error;
  }
  await restore();
  return result;
}
