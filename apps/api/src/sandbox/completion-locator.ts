import type { Database } from "@opengeni/db";
import {
  classifyConnectedCommandOps,
  CONNECTED_COMMAND_CLASSIFY_LIMIT,
  type locateConnectedCommandCompletion,
} from "@opengeni/db/session-background-commands";

type Identity = Parameters<typeof locateConnectedCommandCompletion>[1];
type Located = Awaited<ReturnType<typeof locateConnectedCommandCompletion>>;
export type ConnectedCommandCompletionLocator = (identity: Identity) => Promise<Located>;

/** Combine only concurrently pending lookups for one authenticated process.
 * No timer window, result cache, acknowledgement or collection serialization:
 * each event-loop batch reads fresh state and discards it after resolution. */
export function createConnectedCommandCompletionLocator(
  db: Database,
): ConnectedCommandCompletionLocator {
  type Waiter = { resolve: (row: Located) => void; reject: (error: unknown) => void };
  type Batch = { identity: Omit<Identity, "opId">; operations: Map<string, Waiter[]> };
  const pending = new Map<string, Batch>();

  async function flush(key: string, batch: Batch): Promise<void> {
    // New arrivals always belong to a new read, including while this SQL waits.
    pending.delete(key);
    const operations = [...batch.operations.keys()];
    for (let offset = 0; offset < operations.length; offset += CONNECTED_COMMAND_CLASSIFY_LIMIT) {
      const opIds = operations.slice(offset, offset + CONNECTED_COMMAND_CLASSIFY_LIMIT);
      try {
        const rows = await classifyConnectedCommandOps(db, { ...batch.identity, opIds });
        for (const opId of opIds) {
          // The database's connected-op unique index fixes one row per locator.
          const row = rows.get(opId)?.[0];
          const located = row
            ? {
                accountId: row.accountId,
                workspaceId: row.workspaceId,
                sessionId: row.sessionId,
                commandId: row.commandId,
                terminal: row.state === "exited" || row.state === "lost",
              }
            : null;
          for (const waiter of batch.operations.get(opId)!) waiter.resolve(located);
        }
      } catch (error) {
        for (const opId of opIds) {
          for (const waiter of batch.operations.get(opId)!) waiter.reject(error);
        }
      }
    }
  }

  return (identity) => {
    const { opId, ...process } = identity;
    const key = JSON.stringify([
      process.controlWorkspaceId,
      process.enrollmentId,
      process.connectionInstanceId,
    ]);
    let batch = pending.get(key);
    if (!batch) {
      batch = { identity: process, operations: new Map() };
      pending.set(key, batch);
      const scheduled = batch;
      setImmediate(() => {
        void flush(key, scheduled);
      });
    }
    return new Promise<Located>((resolve, reject) => {
      const waiters = batch.operations.get(opId) ?? [];
      waiters.push({ resolve, reject });
      batch.operations.set(opId, waiters);
    });
  };
}
