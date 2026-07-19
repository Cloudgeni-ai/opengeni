import { dbSearchPath, getSettings } from "@opengeni/config";
import {
  assertRuntimeDatabasePosture,
  createDb,
  FORCE_RLS_TABLES,
  RUNTIME_DML_TABLES,
} from "./index";

const settings = getSettings();
const searchPath = dbSearchPath(settings);
const client = createDb(settings.databaseUrl, {
  ...(searchPath ? { searchPath } : {}),
  rlsStrategy: settings.rlsStrategy,
  max: 1,
});

try {
  const posture = await assertRuntimeDatabasePosture(client.db, {
    rlsStrategy: settings.rlsStrategy,
    expectedRole: settings.runtimeDatabaseRole,
    targetSchema: settings.dbSchema.trim() || "public",
  });
  // Structural evidence only: never print a connection string, secret, GUC, or
  // tenant row. The command is intended for release Jobs and audit artifacts.
  console.log(
    JSON.stringify({
      ok: true,
      rlsStrategy: settings.rlsStrategy,
      currentUser: posture.identity.currentUser,
      sessionUser: posture.identity.sessionUser,
      memberships: posture.memberships.length,
      ownedSchemas: posture.ownedSchemas.length,
      ownedRelations: posture.ownedRelations.length,
      declaredProtectedTables: FORCE_RLS_TABLES.length,
      activeProtectedTables: posture.tables.filter((table) => table.rlsActive).length,
      declaredRuntimeDmlTables: RUNTIME_DML_TABLES.length,
      privilegedRuntimeDmlTables: posture.tables.filter(
        (table) =>
          table.select &&
          table.insert &&
          table.update &&
          table.delete &&
          !table.truncate &&
          !table.references &&
          !table.trigger,
      ).length,
    }),
  );
} finally {
  await client.close();
}
