import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";

import {
  archiveWorkspaceApp,
  claimArchivedAppGc,
  completeAppBuild,
  createDatabaseAppLaunchResolver,
  getAppReleaseToolPolicy,
  prepareAppBuild,
  promoteAppBuild,
  settleArchivedAppGc,
} from "../src/apps";
import {
  FORCE_RLS_TABLES,
  PROTECTED_NO_DIRECT_DML_TABLES,
  RUNTIME_READ_ONLY_TABLES,
  RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES,
} from "../src/runtime-posture";
import {
  appBuilds,
  appBuildFiles,
  appGcClaims,
  appLaunches,
  appLifecycleOperations,
  appObjectTombstones,
  appPreviews,
  appPublications,
  appReleases,
  appSourceRevisions,
  appToolCalls,
  appToolPolicyRevisions,
  apps,
} from "../src/schema";

const migrationUrl = new URL(
  "../drizzle/0377_governed_apps_persistence.sql",
  import.meta.url,
);

const tables = [
  "apps",
  "app_source_revisions",
  "app_tool_policy_revisions",
  "app_builds",
  "app_build_files",
  "app_releases",
  "app_previews",
  "app_publications",
  "app_launches",
  "app_tool_calls",
  "app_lifecycle_operations",
  "app_gc_claims",
  "app_object_tombstones",
] as const;

const protectedTables: readonly string[] = [
  "app_lifecycle_operations",
  "app_gc_claims",
  "app_object_tombstones",
];
const readOnlyTables = tables.filter((table) => !protectedTables.includes(table));

describe("migration 0377 governed Apps persistence", () => {
  test("is additive, tenant-composite, FORCE-RLS, and preserves HTML Artifacts", async () => {
    const source = await Bun.file(migrationUrl).text();
    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/iu);
    expect(source).not.toMatch(/ALTER TABLE\s+"?workspace_artifacts"?/iu);
    expect(source).not.toMatch(/UPDATE\s+"?workspace_artifacts"?/iu);
    for (const table of tables) {
      expect(source).toContain(`'${table}'`);
      expect(FORCE_RLS_TABLES).toContain(table);
    }
    expect(source).toContain("ALTER TABLE %I FORCE ROW LEVEL SECURITY");
    expect(source).toContain("opengeni_private.workspace_rls_visible(account_id, workspace_id)");
    expect(source.match(/^  CONSTRAINT .*_workspace_account_fk/gmu)).toHaveLength(13);
    expect(source).toContain("FOREIGN KEY (workspace_id, app_id, source_revision_id)");
    expect(source).toContain("FOREIGN KEY (workspace_id, app_id, tool_policy_revision_id)");
    expect(source).toContain(
      "FOREIGN KEY (workspace_id, app_id, build_id, source_revision_id, tool_policy_revision_id)",
    );
    expect(source).toContain("FOREIGN KEY (workspace_id, app_id, release_id, preview_id)");
    expect(source).toContain("FOREIGN KEY (workspace_id, app_id, release_id, publication_id)");
    expect(source).toContain("FOREIGN KEY (workspace_id, app_id, release_id, launch_id)");
  });

  test("registers the Drizzle schema and exact least-privilege runtime posture", () => {
    expect(
      [
        apps,
        appSourceRevisions,
        appToolPolicyRevisions,
        appBuilds,
        appBuildFiles,
        appReleases,
        appPreviews,
        appPublications,
        appLaunches,
        appToolCalls,
        appLifecycleOperations,
        appGcClaims,
        appObjectTombstones,
      ].map((table) => getTableName(table)),
    ).toEqual([...tables]);
    for (const table of readOnlyTables) {
      expect(RUNTIME_READ_ONLY_TABLES as readonly string[]).toContain(table);
    }
    expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain("app_lifecycle_operations");
    expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain("app_gc_claims");
    expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain("app_object_tombstones");
    for (const routine of [
      "create_workspace_app_command(jsonb)",
      "update_workspace_app_command(jsonb)",
      "create_app_tool_policy_command(jsonb)",
      "begin_app_source_upload_command(jsonb)",
      "complete_app_source_upload_command(jsonb)",
      "fail_app_source_upload_command(jsonb)",
      "prepare_app_build_command(jsonb)",
      "complete_app_build_command(jsonb)",
      "fail_app_build_command(jsonb)",
      "promote_app_build_command(jsonb)",
      "create_app_preview_command(jsonb)",
      "revoke_app_preview_command(jsonb)",
      "publish_app_release_command(jsonb)",
      "unpublish_workspace_app_command(jsonb)",
      "archive_workspace_app_command(jsonb)",
      "app_launch_command(jsonb)",
      "app_tool_call_command(jsonb)",
      "claim_archived_app_gc_command(jsonb)",
      "settle_archived_app_gc_command(jsonb)",
    ]) {
      expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toContain(routine);
    }
    for (const helper of [
      prepareAppBuild,
      completeAppBuild,
      promoteAppBuild,
      archiveWorkspaceApp,
      getAppReleaseToolPolicy,
      createDatabaseAppLaunchResolver,
      claimArchivedAppGc,
      settleArchivedAppGc,
    ]) {
      expect(typeof helper).toBe("function");
    }
  });

  test("pins OCC, idempotency, immutable release routing, and a narrow App host lookup", async () => {
    const source = await Bun.file(migrationUrl).text();
    expect(source).toContain("app_lifecycle_operations_workspace_operation_uq");
    expect(source).toContain("App idempotency key was reused with different input");
    expect(source).toContain("App version conflict");
    expect(source).toContain("App source upload identity changed");
    expect(source).toContain("App build manifest changed");
    expect(source).toContain("App build frozen file receipts are incomplete");
    expect(source).toContain("App build file freeze identity changed");
    expect(source).toContain("Immutable App history rows cannot be deleted");
    expect(source).toContain("App GC completion does not cover the exact claim");
    expect(source).toContain("CREATE TABLE app_build_files");
    expect(source).toContain("staging_object_key text NOT NULL");
    expect(source).toContain("frozen_object_key text NOT NULL");
    expect(source).toContain("actor_subject_id_value IS DISTINCT FROM caller_subject_id_value");
    expect(source).toContain("authority_generation text NOT NULL");
    expect(source).toContain("action_value = 'promote_build'");
    expect(source).toContain("action_value = 'archive_app'");
    expect(source).toContain("App tool operation was reused with different input");
    expect(source).toContain("App tool operation settlement was reused with different output");
    expect(source).toContain("policy_row.allowed_tools @> jsonb_build_array(p_input->'identity')");
    expect(source).toContain("SECURITY DEFINER");
    expect(source).toContain("SET search_path = pg_catalog, %I, pg_temp");
    expect(source).toContain("opengeni_private.resolve_app_host_launch(");
    expect(source).toContain("WHERE route.hostname = lower(p_hostname)");
    expect(source).toContain("AND route.nonce_sha256 = p_launch_token_digest");
    expect(source).toContain("LEFT JOIN app_host_route_files requested");
    expect(source).toContain("JOIN app_host_route_files entry_file");
    expect(source).toContain(
      "requested.path, requested.object_key, route.entry_path, entry_file.object_key",
    );
    expect(source).toContain(
      "ON entry_file.launch_id = route.launch_id AND entry_file.path = route.entry_path",
    );
    expect(source).toContain(
      "ON requested.launch_id = route.launch_id AND requested.path = p_requested_path",
    );
    expect(source).toContain("AND route.expires_at > clock_timestamp()");

    const resolver = source.slice(source.indexOf("CREATE FUNCTION opengeni_private.resolve_app_host_launch"));
    const resolverBody = resolver.slice(0, resolver.indexOf("REVOKE ALL ON FUNCTION"));
    expect(resolverBody).not.toContain("account_id");
    expect(resolverBody).not.toContain("workspace_id");
    expect(resolverBody).not.toContain("source_revision_id");
    expect(resolverBody).not.toContain("app_source_revisions");
    expect(source).toContain("REVOKE ALL ON TABLE opengeni_private.app_host_routes FROM PUBLIC");
    expect(source).toContain(
      "REVOKE ALL ON TABLE opengeni_private.app_host_route_files FROM PUBLIC",
    );
    expect(source).toContain("REVOKE ALL ON FUNCTION app_lifecycle_command_internal(jsonb)");
    expect(source).not.toContain("GRANT EXECUTE ON FUNCTION %I.app_lifecycle_command_internal");
    expect(source).toContain("GRANT SELECT ON TABLE %I.apps");
    expect(source).not.toContain("GRANT INSERT ON TABLE %I.apps");
    expect(source).not.toContain("GRANT UPDATE ON TABLE %I.apps");
  });
});