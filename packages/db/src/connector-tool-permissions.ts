import { and, asc, eq, sql } from "drizzle-orm";
import type { ConnectorToolPermission } from "@opengeni/contracts";
import { withRlsContext, type Database } from "./database";
import * as schema from "./schema";
import { upsertConnectorActionPolicy } from "./index";

export async function listConnectorToolPermissionPolicies(
  db: Database,
  input: { accountId: string; workspaceId: string; connectionId: string },
) {
  return withRlsContext(db, input, async (tx) =>
    tx
      .select()
      .from(schema.connectorActionPolicies)
      .where(
        and(
          eq(schema.connectorActionPolicies.workspaceId, input.workspaceId),
          eq(schema.connectorActionPolicies.connectionId, input.connectionId),
        ),
      )
      .orderBy(asc(schema.connectorActionPolicies.id)),
  );
}

/** All tools in a group change together, and never exceed the attempt snapshot bound. */
export async function updateConnectorToolPermissionPolicies(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    connectionId: string;
    serverId: string;
    toolNames: string[];
    policy: ConnectorToolPermission;
  },
): Promise<void> {
  await withRlsContext(db, input, async (scoped) =>
    scoped.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`connector-tool-permissions:${input.workspaceId}`}, 0))`,
      );
      const existing = await tx
        .select()
        .from(schema.connectorActionPolicies)
        .where(eq(schema.connectorActionPolicies.workspaceId, input.workspaceId));
      const names = [...new Set(input.toolNames)].sort((left, right) => left.localeCompare(right));
      const added = names.filter(
        (name) =>
          !existing.some(
            (row) =>
              row.connectionId === input.connectionId &&
              row.serverId === input.serverId &&
              row.toolName === name &&
              row.actionName === "*",
          ),
      );
      if (existing.length + added.length > 2048)
        throw new Error("The workspace tool permission limit has been reached");
      for (const toolName of names) {
        await upsertConnectorActionPolicy(tx, { ...input, toolName, actionName: "*" });
      }
    }),
  );
}
