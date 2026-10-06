import { and, eq } from "drizzle-orm";
import { type Database, withRlsContext } from "./database";
import { sessions } from "./schema";
import { sandboxGroupEngines, sandboxV2Machines } from "./sandbox-v2-schema";

export type SandboxSessionEngineRoute =
  | { engine: "legacy"; sandboxGroupId: string }
  | { engine: "machine-v2"; sandboxGroupId: string; machineId: string; provider: string };

/** Read the immutable group choice from the retained session, independently of
 * current admission flags or deployment defaults. This routing identity grants
 * no machine/command authority; establishment must acquire the exact attempt.
 * A missing or inconsistent v2 row must never become a legacy route. */
export async function readSandboxSessionEngineRoute(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string },
): Promise<SandboxSessionEngineRoute> {
  const context = { ...input };
  return withRlsContext(db, context, async (tx) => {
    const [row] = await tx
      .select({
        sandboxGroupId: sessions.sandboxGroupId,
        engine: sandboxGroupEngines.engine,
        machineId: sandboxV2Machines.id,
        provider: sandboxV2Machines.provider,
      })
      .from(sessions)
      .leftJoin(
        sandboxGroupEngines,
        and(
          eq(sandboxGroupEngines.accountId, sessions.accountId),
          eq(sandboxGroupEngines.workspaceId, sessions.workspaceId),
          eq(sandboxGroupEngines.sandboxGroupId, sessions.sandboxGroupId),
        ),
      )
      .leftJoin(
        sandboxV2Machines,
        and(
          eq(sandboxV2Machines.accountId, sessions.accountId),
          eq(sandboxV2Machines.workspaceId, sessions.workspaceId),
          eq(sandboxV2Machines.sandboxGroupId, sessions.sandboxGroupId),
        ),
      )
      .where(
        and(
          eq(sessions.accountId, context.accountId),
          eq(sessions.workspaceId, context.workspaceId),
          eq(sessions.id, context.sessionId),
        ),
      )
      .limit(1);
    if (!row) throw new Error("Sandbox session route unavailable");
    if (row.engine === "legacy" && row.machineId !== null)
      throw new Error("Sandbox group engine identity is inconsistent");
    if (row.engine === "machine-v2" || row.machineId !== null) {
      if (!row.machineId || !row.provider)
        throw new Error("Retained sandbox machine route unavailable");
      return {
        engine: "machine-v2",
        sandboxGroupId: row.sandboxGroupId,
        machineId: row.machineId,
        provider: row.provider,
      };
    }
    return { engine: "legacy", sandboxGroupId: row.sandboxGroupId };
  });
}
