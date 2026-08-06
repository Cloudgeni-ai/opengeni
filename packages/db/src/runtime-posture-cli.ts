import {
  dbSearchPath,
  getSettings,
  servingDatabaseRole,
  servingDatabaseUrl,
} from "@opengeni/config";
import {
  assertRuntimeDatabasePosture,
  createDb,
  ENABLED_V2_PROTECTED_NO_DIRECT_DML_TABLES,
  ENABLED_V2_PROTECTED_TABLES,
  ENABLED_V2_TABLE_PRIVILEGES,
  FORCE_RLS_TABLES,
  PROTECTED_NO_DIRECT_DML_TABLES,
  RUNTIME_TABLE_PRIVILEGES,
} from "./index";

const settings = getSettings();
const tablePrivileges = settings.organizationGovernanceEnabled
  ? ENABLED_V2_TABLE_PRIVILEGES
  : RUNTIME_TABLE_PRIVILEGES;
const fullDmlPrivilegeCount = Object.values(tablePrivileges).filter(
  (privileges) => privileges.length === 4,
).length;
const readOnlyPrivilegeCount = Object.values(tablePrivileges).filter(
  (privileges) => privileges.length === 1 && privileges[0] === "SELECT",
).length;
const readInsertPrivilegeCount = Object.values(tablePrivileges).filter(
  (privileges) =>
    privileges.length === 2 && privileges[0] === "SELECT" && privileges[1] === "INSERT",
).length;
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
    ...(settings.organizationGovernanceEnabled
      ? {
          protectedTables: ENABLED_V2_PROTECTED_TABLES,
          tablePrivileges: ENABLED_V2_TABLE_PRIVILEGES,
          protectedNoDirectDmlTables: ENABLED_V2_PROTECTED_NO_DIRECT_DML_TABLES,
        }
      : {}),
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
      declaredProtectedTables: settings.organizationGovernanceEnabled
        ? ENABLED_V2_PROTECTED_TABLES.length
        : FORCE_RLS_TABLES.length,
      activeProtectedTables: posture.tables.filter((table) => table.rlsActive).length,
      declaredFullDmlTables: fullDmlPrivilegeCount,
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
      declaredReadOnlyTables: readOnlyPrivilegeCount,
      declaredReadInsertTables: readInsertPrivilegeCount,
      declaredProtectedNoDirectDmlTables: settings.organizationGovernanceEnabled
        ? ENABLED_V2_PROTECTED_NO_DIRECT_DML_TABLES.length
        : PROTECTED_NO_DIRECT_DML_TABLES.length,
    }),
  );
} finally {
  await client.close();
}
