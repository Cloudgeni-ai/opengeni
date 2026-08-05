import { and, eq, gt } from "drizzle-orm";

import type { Database } from "./database";
import * as schema from "./schema";

export async function sessionRealtimeIsActiveInTransaction(
  db: Database,
  workspaceId: string,
  sessionId: string,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.sessionRealtimeModes.id })
    .from(schema.sessionRealtimeModes)
    .where(
      and(
        eq(schema.sessionRealtimeModes.workspaceId, workspaceId),
        eq(schema.sessionRealtimeModes.sessionId, sessionId),
        eq(schema.sessionRealtimeModes.state, "active"),
        gt(schema.sessionRealtimeModes.leaseExpiresAt, now),
      ),
    )
    .limit(1);
  return Boolean(row);
}
