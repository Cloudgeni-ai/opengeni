import {
  dbSearchPath,
  getSettings,
  servingDatabaseRole,
  servingDatabaseUrl,
} from "@opengeni/config";
import {
  assertRuntimeDatabasePosture,
  createDb,
  FORCE_RLS_TABLES,
  PROTECTED_NO_DIRECT_DML_TABLES,
  RUNTIME_FULL_DML_TABLES,
  RUNTIME_READ_INSERT_TABLES,
  RUNTIME_READ_ONLY_TABLES,
} from "./index";

const settings = getSettings();
const searchPath = dbSearchPath(settings);
const client = createDb(servingDatabaseUrl(settings), {
  ...(searchPath ? { searchPath } : {}),
  rlsStrategy: settings.rlsStrategy,
  connectionAuthority: {
    expectedRole: servingDatabaseRole(settings),
    forbiddenRoles: [
      settings.organizationGovernanceEnabled
        ? settings.runtimeDatabaseRole
        : settings.organizationGovernanceDatabaseRole,
      "opengeni_governance_operator",
    ],
  },
  max: 1,
});

try {
  const posture = await assertRuntimeDatabasePosture(client.db, {
    rlsStrategy: settings.rlsStrategy,
    expectedRole: servingDatabaseRole(settings),
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
      declaredFullDmlTables: RUNTIME_FULL_DML_TABLES.length,
      privilegedFullDmlTables: posture.tables.filter(
        (table) =>
          table.select &&
          table.insert &&
          table.update &&
          table.delete &&
          !table.truncate &&
          !table.references &&
          !table.trigger,
      ).length,
      declaredReadOnlyTables: RUNTIME_READ_ONLY_TABLES.length,
      declaredReadInsertTables: RUNTIME_READ_INSERT_TABLES.length,
      declaredProtectedNoDirectDmlTables: PROTECTED_NO_DIRECT_DML_TABLES.length,
    }),
  );
} finally {
  await client.close();
}
