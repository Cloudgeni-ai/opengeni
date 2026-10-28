import { sql } from "drizzle-orm";
import { withWorkspaceSessionActivityRls } from "../../src";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "../../src/database";

/** The header shape the legacy SQL listing returns (no variable values). */
type VariableSet = {
  id: string;
  name: string;
  scope: "organization" | "workspace" | "user";
  generation: number;
  [key: string]: unknown;
};

/**
 * Test-only fixture for legacy Variable Sets. The product no longer creates
 * them, but the tables, columns and admission fences remain until the
 * contract migration, so historical tests still seed rows through the
 * original SQL routine.
 */
export async function createLegacyVariableSet(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    scope?: VariableSet["scope"];
    subjectId?: string;
    allowOrganization?: boolean;
    name: string;
    description?: string | null;
    variables?: Array<{ name: string; valueEncrypted: string }>;
  },
): Promise<VariableSet> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      if (input.subjectId) await setSubjectRlsContext(scopedDb, input.subjectId);
      const created = await rawRows<{ variableSetId: string }>(
        scopedDb,
        sql`select variable_set_id as "variableSetId"
          from create_scoped_variable_set(
            ${input.accountId}::uuid,
            ${input.workspaceId}::uuid,
            ${input.scope ?? "workspace"},
            ${input.name},
            ${input.description ?? null},
            ${JSON.stringify(input.variables ?? [])}::jsonb,
            ${input.allowOrganization === true}
          )`,
      );
      const variableSetId = created[0]?.variableSetId;
      if (!variableSetId) throw new Error("Failed to create variable set");
      const rows = await rawRows<{ value: VariableSet }>(
        scopedDb,
        sql`select value from list_scoped_variable_sets(
          ${input.accountId}::uuid, ${input.workspaceId}::uuid,
          ${variableSetId}::uuid, null, null
        ) value`,
      );
      if (!rows[0]) throw new Error("Failed to create variable set");
      return rows[0].value;
    },
  );
}

/** Test-only listing of legacy Variable Set headers visible to a subject. */
export async function listLegacyVariableSets(
  db: Database,
  context: { accountId: string; workspaceId: string; subjectId: string },
): Promise<VariableSet[]> {
  return await withRlsContext(db, context, async (scopedDb) => {
    await setSubjectRlsContext(scopedDb, context.subjectId);
    const rows = await rawRows<{ value: VariableSet }>(
      scopedDb,
      sql`select value from list_scoped_variable_sets(
        ${context.accountId}::uuid, ${context.workspaceId}::uuid, null, null, null
      ) value`,
    );
    return rows.map((row) => row.value);
  });
}

/**
 * Test-only: attach legacy Variable Sets to an existing session. Sessions can
 * no longer select sets, but rows attached before the removal still exist and
 * the database fences keep honouring them until the tables are dropped.
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
