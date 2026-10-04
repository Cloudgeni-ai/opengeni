import type { ScheduledTask } from "@opengeni/contracts";
import { getScheduledTaskIncludingDeleted, type Database } from "@opengeni/db";
import { sql } from "drizzle-orm";

const LOCK_TIMEOUT = "5s";
const WRITE_TIMEOUT_MS = 5_000;

type TemporalScheduleSyncDependencies = {
  db: Database;
  withDeadline<T>(deadline: number, work: () => Promise<T>): Promise<T>;
  upsert(task: ScheduledTask): Promise<void>;
  /** Idempotent: an absent Temporal schedule is already removed. */
  remove(temporalScheduleId: string): Promise<void>;
};

/**
 * Serialize external writes across API replicas, independently of task edits.
 * A queued sync rereads the newest committed row after acquiring this lock;
 * input snapshots never become desired state. Cleanup uses the same key, so
 * an in-flight upsert finishes before its tombstone's external deletion.
 * Failure compensation commits before releasing the lock, so a queued writer
 * cannot read the row being restored and then publish that failed edit.
 *
 * Deadlines bound both lock admission and network occupancy. A thrown network
 * error retains its unknown-outcome semantics; this is not durable recovery
 * for a process crash or a lost Temporal acknowledgement.
 */
export function createTemporalScheduleSynchronizer(deps: TemporalScheduleSyncDependencies) {
  const write = async <T>(
    temporalScheduleId: string,
    work: (tx: Database) => Promise<T>,
  ): Promise<T> =>
    deps.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`);
      await tx.execute(sql`select pg_advisory_xact_lock(
        hashtextextended(${`scheduled-task-temporal:${temporalScheduleId}`}, 0)
      )`);
      return await work(tx);
    });

  return {
    async sync(
      task: Pick<ScheduledTask, "id" | "workspaceId" | "temporalScheduleId">,
      onFailure?: (tx: Database, error: unknown) => Promise<Error>,
    ) {
      const result = await write(task.temporalScheduleId, async (tx) => {
        try {
          await deps.withDeadline(Date.now() + WRITE_TIMEOUT_MS, async () => {
            const current = await getScheduledTaskIncludingDeleted(tx, task.workspaceId, task.id);
            if (current && current.temporalScheduleId !== task.temporalScheduleId)
              throw new Error("Scheduled task Temporal identity changed");
            if (!current || current.deletedAt !== null || current.schedule.type === "manual") {
              await deps.remove(task.temporalScheduleId);
              return;
            }
            const { deletedAt: _deletedAt, ...latest } = current;
            await deps.upsert(latest);
          });
          return { ok: true as const };
        } catch (error) {
          return { ok: false as const, error: onFailure ? await onFailure(tx, error) : error };
        }
      });
      // Throw after commit: throwing inside the transaction would also undo a
      // successful compensation. A failed commit cannot claim that receipt.
      if (!result.ok) throw result.error;
    },
    async remove(temporalScheduleId: string) {
      await write(temporalScheduleId, async () =>
        deps.withDeadline(Date.now() + WRITE_TIMEOUT_MS, () => deps.remove(temporalScheduleId)),
      );
    },
  };
}
