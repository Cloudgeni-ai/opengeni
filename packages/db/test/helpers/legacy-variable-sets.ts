import { sql } from "drizzle-orm";
import { withWorkspaceSessionActivityRls } from "../../src";
import type { Database } from "../../src/database";

/**
 * Seed historical selection columns through the ordinary session activity gate.
 * Prefix-ledger migration tests use real old sets; current-schema tests keep
 * only the historical UUIDs after the retired resource tables disappear.
 */
export async function attachLegacyVariableSets(
  db: Database,
  input: { workspaceId: string; sessionId: string; variableSetIds: string[] },
): Promise<void> {
  await withWorkspaceSessionActivityRls(db, input.workspaceId, async (tx) => {
    await tx.execute(sql`
      update sessions
      set variable_set_ids = ${JSON.stringify(input.variableSetIds)}::jsonb,
          variable_set_id = ${input.variableSetIds.at(-1) ?? null}::uuid,
          updated_at = now()
      where workspace_id = ${input.workspaceId} and id = ${input.sessionId}
    `);
  });
}
