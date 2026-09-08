import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Database } from "./database";
import * as schema from "./schema";

/** Only a durable turn.started event establishes inherited execution policy. */
export function latestStartedSessionTurnQuery(
  db: Database,
  workspaceId: string,
  sessionId: string | SQL,
) {
  return db
    .select({
      id: schema.sessionTurns.id,
      model: schema.sessionTurns.model,
      reasoningEffort: schema.sessionTurns.reasoningEffort,
      latencyMode: schema.sessionTurns.latencyMode,
    })
    .from(schema.sessionEvents)
    .innerJoin(
      schema.sessionTurns,
      and(
        eq(schema.sessionEvents.workspaceId, schema.sessionTurns.workspaceId),
        eq(schema.sessionEvents.sessionId, schema.sessionTurns.sessionId),
        eq(schema.sessionEvents.turnId, schema.sessionTurns.id),
      ),
    )
    .where(
      and(
        eq(schema.sessionEvents.workspaceId, workspaceId),
        eq(schema.sessionEvents.sessionId, sessionId),
        eq(schema.sessionEvents.type, "turn.started"),
      ),
    )
    .orderBy(desc(schema.sessionEvents.sequence))
    .limit(1);
}

type PolicyRow = Pick<
  typeof schema.sessions.$inferSelect,
  "id" | "model" | "reasoningEffort" | "latencyMode"
>;

/** Read projection only: never overwrite creation settings or accepted turns.
 * Call inside the caller's existing workspace/subject RLS boundary.
 * One bounded lateral lookup per listed session, not one network call per row.
 */
export async function withLatestStartedSessionPolicy<T extends PolicyRow>(
  db: Database,
  workspaceId: string,
  rows: readonly T[],
): Promise<T[]> {
  if (rows.length === 0) return [];
  const latest = latestStartedSessionTurnQuery(db, workspaceId, sql`${schema.sessions.id}`).as(
    "latest_started_policy",
  );
  const policies = await db
    .select({
      id: schema.sessions.id,
      model: latest.model,
      reasoningEffort: latest.reasoningEffort,
      latencyMode: latest.latencyMode,
    })
    .from(schema.sessions)
    .leftJoinLateral(latest, sql`true`)
    .where(
      and(
        eq(schema.sessions.workspaceId, workspaceId),
        inArray(schema.sessions.id, [...new Set(rows.map((row) => row.id))]),
      ),
    );
  const byId = new Map(policies.map((policy) => [policy.id, policy]));
  return rows.map((row) => {
    const policy = byId.get(row.id);
    return policy?.model
      ? {
          ...row,
          model: policy.model,
          reasoningEffort: policy.reasoningEffort ?? row.reasoningEffort,
          latencyMode: policy.latencyMode ?? row.latencyMode,
        }
      : row;
  });
}
