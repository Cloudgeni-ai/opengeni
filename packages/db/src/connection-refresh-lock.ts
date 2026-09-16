import { sql } from "drizzle-orm";
import { setSubjectRlsContext, withRlsContext, type Database } from "./database";
import type { ConnectionCredentialForBroker } from "./connection-token-resolver";

/** Serialize rotating-token exchange across workers, not only within one process. */
export async function withConnectionRefreshLock<T>(
  db: Database,
  credential: ConnectionCredentialForBroker,
  work: (lockedDb: Database) => Promise<T>,
): Promise<T> {
  return withRlsContext(
    db,
    { accountId: credential.accountId, workspaceId: credential.workspaceId },
    async (tx) => {
      if (credential.subjectId) await setSubjectRlsContext(tx, credential.subjectId);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`connection-refresh:${credential.id}`}, 0))`,
      );
      return work(tx);
    },
  );
}
