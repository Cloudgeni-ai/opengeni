import { acquireBlankTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

/** Historical migration proofs run against the last schema that owned Memory.
 * Current-runtime denial and conversion are exercised by migration-0461 and
 * unified-knowledge-postgres; never disable retirement triggers in those tests. */
export async function acquirePreKnowledgeTestDatabase(
  label: string,
): Promise<SharedTestDatabase | null> {
  const blank = await acquireBlankTestDatabase(label);
  if (!blank) return null;
  const admin = postgres(blank.databaseUrl, { max: 4, onnotice: () => undefined });
  try {
    await admin`CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    await admin`INSERT INTO schema_migrations(name) VALUES ('0461_unified_knowledge.sql')`;
    await migrate(blank.databaseUrl);
    await admin`DELETE FROM schema_migrations WHERE name='0461_unified_knowledge.sql'`;
    if (!blank.appPassword)
      throw new Error("Historical fixture requires the shared runtime password");
    await provisionRoles(blank.databaseUrl, {
      appPassword: blank.appPassword,
      rlsStrategy: "force",
    });
    // Restore only the retired grants of the historical runtime being tested.
    await admin.unsafe(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_memories TO opengeni_app;
      GRANT INSERT ON workspace_learning_policy_revisions TO opengeni_app;
      GRANT EXECUTE ON FUNCTION knowledge_memory_apply_operation(jsonb,text,text,text,uuid,uuid,uuid,integer) TO opengeni_app;
      GRANT EXECUTE ON FUNCTION knowledge_memory_revert_operation(uuid,uuid,text,text,text,uuid,uuid,uuid,integer) TO opengeni_app;
      GRANT EXECUTE ON FUNCTION workspace_learning_policy_apply_activation(uuid,text,uuid,uuid,uuid,uuid,bigint,text,text,text) TO opengeni_app;
    `);
    const appUrl = new URL(blank.databaseUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = blank.appPassword;
    return {
      admin,
      adminUrl: blank.databaseUrl,
      appUrl: appUrl.toString(),
      release: async () => {
        await admin.end({ timeout: 5 });
        await blank.release();
      },
    };
  } catch (error) {
    await admin.end({ timeout: 5 });
    await blank.release();
    throw error;
  }
}
