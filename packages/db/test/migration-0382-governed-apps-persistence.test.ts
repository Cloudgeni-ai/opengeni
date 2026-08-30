import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import postgres from "postgres";

import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";

import {
  archiveWorkspaceApp,
  claimArchivedAppGc,
  completeAppBuild,
  createAppPreview,
  createWorkspaceApp,
  createDatabaseAppLaunchResolver,
  getAppReleaseToolPolicy,
  listWorkspaceApps,
  prepareAppBuild,
  promoteAppBuild,
  settleArchivedAppGc,
} from "../src/apps";
import { createDb, nestedPostgresSqlState } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
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

const migrationUrl = new URL("../drizzle/0382_governed_apps_persistence.sql", import.meta.url);
const migrationName = "0382_governed_apps_persistence.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const externalAdminUrl = process.env.OPENGENI_TEST_THROWAWAY_DATABASE_ADMIN_URL?.trim();
const externalAppPassword = "apps-postgres-test-password";

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

describe("migration 0382 governed Apps persistence", () => {
  test("is additive, tenant-composite, FORCE-RLS, and preserves HTML Artifacts", async () => {
    const source = await Bun.file(migrationUrl).text();
    expect(source).toStartWith("-- deployment-mode: maintenance");
    expect(source).toContain("opengeni.migration_application_roles");
    expect(source).toContain(
      "0382 governed Apps persistence requires all configured OpenGeni application database sessions to be stopped",
    );
    expect(source).toContain("LOCK TABLE managed_accounts IN ACCESS EXCLUSIVE MODE");
    expect(source).toContain("LOCK TABLE workspaces IN ACCESS EXCLUSIVE MODE");
    expect(source).toContain(
      "0382 governed Apps persistence observed a configured OpenGeni application database session after locking",
    );
    expect(source).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/iu);
    expect(source).not.toMatch(/ALTER TABLE\s+"?workspace_artifacts"?/iu);
    expect(source).not.toMatch(/UPDATE\s+"?workspace_artifacts"?/iu);
    for (const table of tables) {
      expect(source).toContain(`'${table}'`);
      expect(FORCE_RLS_TABLES).toContain(table);
    }
    expect(source).toContain("ALTER TABLE %I FORCE ROW LEVEL SECURITY");
    expect(source).toContain("opengeni_private.workspace_rls_visible(account_id, workspace_id)");
    expect(source).toContain("CREATE POLICY session_visibility_isolation");
    expect(source).toContain("ON app_source_revisions AS RESTRICTIVE");
    expect(source).toContain(
      "session_reference_visible(account_id, workspace_id, source_session_id)",
    );
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
    expect(source).toContain("pg_catalog.pg_trigger_depth() > 1");
    expect(source).toContain("'SELECT NOT EXISTS (SELECT 1 FROM %I.workspaces WHERE id = $1)'");
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION opengeni_private.enforce_app_immutable_rows() FROM PUBLIC",
    );
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
    expect(source).toContain("PERFORM 1 FROM apps\n    WHERE workspace_id = workspace_id_value");
    expect(source).toContain("action_value = 'begin' AND call_row.status = 'pending'");
    expect(source).toContain(
      "launch_row.status <> 'active' OR launch_row.expires_at <= clock_timestamp()",
    );
    expect(source).toContain("octet_length(tool_server_id) BETWEEN 1 AND 256");
    expect(source).toContain("octet_length(allowed_tool->>'serverId') NOT BETWEEN 1 AND 256");
    expect(source).not.toContain("[A-Za-z0-9_-]{1,256}");
    expect(source).toContain("call_row.output IS DISTINCT FROM (\n          CASE");
    expect(source).toContain("call_row.error IS DISTINCT FROM (\n          CASE");
    expect(source).toContain("policy_row.allowed_tools @> jsonb_build_array(p_input->'identity')");
    expect(source).toContain("SECURITY DEFINER");
    expect(source).toContain("SET search_path = pg_catalog, %I, pg_temp");
    expect(source).toContain("opengeni_private.resolve_app_host_launch(");
    expect(source).toContain("WHERE route.hostname = lower(p_hostname)");
    expect(source).toContain("AND route.nonce_sha256 = p_launch_token_digest");
    expect(source).toContain("LEFT JOIN app_host_route_files requested");
    expect(source).toContain("JOIN app_host_route_files entry_file");
    expect(source).toContain("requested.version_token");
    expect(source).toContain("entry_file.version_token");
    expect(source).toContain("requested.path, requested.object_key, requested.version_token,");
    expect(source).toContain("route.entry_path, entry_file.object_key, entry_file.version_token");
    expect(source).toContain(
      "ON entry_file.launch_id = route.launch_id AND entry_file.path = route.entry_path",
    );
    expect(source).toContain(
      "ON requested.launch_id = route.launch_id AND requested.path = p_requested_path",
    );
    expect(source).toContain("AND route.expires_at > clock_timestamp()");
    expect(source).not.toContain("app_previews_active_host_uq");
    expect(source).toContain("app_previews_host_status_expiry_idx");
    expect(source).toContain("CONSTRAINT app_host_routes_launch_fk FOREIGN KEY (launch_id)");

    const createPreview = source.slice(
      source.indexOf("ELSIF action_value = 'create_preview'"),
      source.indexOf("ELSIF action_value = 'revoke_preview'"),
    );
    const revokePreview = source.slice(
      source.indexOf("ELSIF action_value = 'revoke_preview'"),
      source.indexOf("ELSIF action_value = 'publish_release'"),
    );
    const createLaunch = source.slice(
      source.indexOf("CREATE FUNCTION app_launch_command"),
      source.indexOf("CREATE FUNCTION app_tool_call_command"),
    );
    expect(createPreview).toContain("status = 'active'\n    FOR UPDATE;");
    expect(revokePreview).toContain("id = app_id_value FOR UPDATE;");
    expect(createLaunch).toContain("status = 'active'\n  FOR UPDATE;");

    const resolver = source.slice(
      source.indexOf("CREATE FUNCTION opengeni_private.resolve_app_host_launch"),
    );
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

let clean: OwnerMigratedTestDatabase | null = null;
let upgrade: OwnerMigratedTestDatabase | null = null;
let cleanAccountId = "";
let cleanWorkspaceId = "";
let otherWorkspaceId = "";
let upgradedArtifactId = "";

beforeAll(async () => {
  clean = await acquireAppsOwnerDatabase("migration-0382-apps-clean");
  upgrade = await acquireAppsOwnerDatabase("migration-0382-apps-upgrade");
  if (!clean || !upgrade) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0382-governed-apps] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    return;
  }

  await migrate(clean.ownerUrl);
  await provisionRoles(clean.adminUrl, {
    appPassword: clean.appPassword,
    rlsStrategy: "force",
  });
  const [cleanAccount] = await clean.admin<Array<{ id: string }>>`
    insert into managed_accounts (name) values (${`apps-clean-${crypto.randomUUID()}`}) returning id`;
  cleanAccountId = cleanAccount!.id;
  const cleanWorkspaces = await Promise.all(
    ["primary", "other"].map(async (name) => {
      const [workspace] = await clean!.admin<Array<{ id: string }>>`
        insert into workspaces (account_id, name)
        values (${cleanAccountId}, ${`apps-${name}-${crypto.randomUUID()}`}) returning id`;
      await clean!.admin`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspace!.id}, ${cleanAccountId})`;
      return workspace!.id;
    }),
  );
  cleanWorkspaceId = cleanWorkspaces[0]!;
  otherWorkspaceId = cleanWorkspaces[1]!;

  const upgradeOwner = postgres(upgrade.ownerUrl, {
    max: 1,
    prepare: false,
    onnotice: () => undefined,
  });
  try {
    await upgradeOwner.unsafe(
      'CREATE TABLE IF NOT EXISTS "schema_migrations" ("name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())',
    );
    await upgradeOwner`
      insert into schema_migrations (name) values (${migrationName}) on conflict do nothing`;
  } finally {
    await upgradeOwner.end();
  }
  await migrate(upgrade.ownerUrl);

  const [upgradeAccount] = await upgrade.admin<Array<{ id: string }>>`
    insert into managed_accounts (name) values (${`apps-upgrade-${crypto.randomUUID()}`}) returning id`;
  const [upgradeWorkspace] = await upgrade.admin<Array<{ id: string }>>`
    insert into workspaces (account_id, name)
    values (${upgradeAccount!.id}, ${`apps-upgrade-${crypto.randomUUID()}`}) returning id`;
  const [artifact] = await upgrade.admin<Array<{ id: string }>>`
    insert into workspace_artifacts (
      account_id, workspace_id, slug, title, created_by_subject_id
    ) values (
      ${upgradeAccount!.id}, ${upgradeWorkspace!.id}, 'legacy-html', 'Legacy HTML',
      'human:legacy'
    ) returning id`;
  upgradedArtifactId = artifact!.id;

  await upgrade.admin`delete from schema_migrations where name = ${migrationName}`;
  await migrate(upgrade.ownerUrl);
  await provisionRoles(upgrade.adminUrl, {
    appPassword: upgrade.appPassword,
    rlsStrategy: "force",
  });
}, 900_000);

afterAll(async () => {
  await clean?.release();
  await upgrade?.release();
}, 180_000);

describe("migration 0382 live PostgreSQL posture", () => {
  test("rejects a live pre-0382 application role and applies after the role is drained", async () => {
    const guarded = await acquireAppsOwnerDatabase("migration-0382-apps-maintenance-guard");
    if (!guarded) {
      if (requireRealDatabase) {
        throw new Error(
          "[migration-0382-governed-apps] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
        );
      }
      return;
    }

    const owner = postgres(guarded.ownerUrl, {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    let runtime: postgres.Sql | null = null;
    try {
      await owner.unsafe(
        'CREATE TABLE IF NOT EXISTS "schema_migrations" ("name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())',
      );
      await owner`
          insert into schema_migrations (name) values (${migrationName}) on conflict do nothing`;
      await migrate(guarded.ownerUrl);
      await provisionRoles(guarded.adminUrl, {
        appPassword: guarded.appPassword,
        rlsStrategy: "force",
      });
      runtime = postgres(runtimeUrl(guarded.adminUrl, guarded.appPassword), {
        max: 1,
        prepare: false,
        onnotice: () => undefined,
      });
      await runtime`select 1`;
      await owner`delete from schema_migrations where name = ${migrationName}`;

      await expect(migrate(guarded.ownerUrl)).rejects.toThrow(
        "0382 governed Apps persistence requires all configured OpenGeni application database sessions to be stopped",
      );
      const [blocked] = await guarded.admin<Array<{ applied: boolean; appsPresent: boolean }>>`
          select
            exists(select 1 from schema_migrations where name = ${migrationName}) as applied,
            to_regclass('public.apps') is not null as "appsPresent"`;
      expect(blocked).toEqual({ applied: false, appsPresent: false });

      await runtime.end();
      runtime = null;
      await migrate(guarded.ownerUrl);
      const [applied] = await guarded.admin<Array<{ applied: boolean; appsPresent: boolean }>>`
          select
            exists(select 1 from schema_migrations where name = ${migrationName}) as applied,
            to_regclass('public.apps') is not null as "appsPresent"`;
      expect(applied).toEqual({ applied: true, appsPresent: true });
    } finally {
      await runtime?.end().catch(() => undefined);
      await owner.end().catch(() => undefined);
      await guarded.release();
    }
  }, 900_000);

  test("applies cleanly as a NOSUPERUSER NOBYPASSRLS owner with FORCE RLS", async () => {
    if (!clean) return;
    const [owner] = await clean.admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as superuser, rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${clean.ownerRole}`;
    expect(owner).toEqual({ superuser: false, bypassRls: false });

    const migrationRows = await clean.admin<Array<{ name: string }>>`
      select name from schema_migrations where name = ${migrationName}`;
    expect(Array.from(migrationRows)).toEqual([{ name: migrationName }]);

    const forced = await clean.admin<Array<{ name: string; forced: boolean }>>`
      select relation.relname::text as name, relation.relforcerowsecurity as forced
      from pg_class relation
      where relation.relname = any(${clean.admin.array([...tables])})
      order by relation.relname`;
    expect(forced).toHaveLength(tables.length);
    expect(forced.every((row) => row.forced)).toBe(true);

    const [sourceVisibilityPolicy] = await clean.admin<
      Array<{
        permissive: string;
        command: string;
        usingExpression: string;
        checkExpression: string;
      }>
    >`
      select permissive, cmd as command, qual as "usingExpression", with_check as "checkExpression"
      from pg_policies
      where schemaname = current_schema()
        and tablename = 'app_source_revisions'
        and policyname = 'session_visibility_isolation'`;
    expect(sourceVisibilityPolicy).toEqual({
      permissive: "RESTRICTIVE",
      command: "ALL",
      usingExpression: "session_reference_visible(account_id, workspace_id, source_session_id)",
      checkExpression: "session_reference_visible(account_id, workspace_id, source_session_id)",
    });

    const [immutableGuardAcl] = await clean.admin<
      Array<{
        publicExecute: boolean;
      }>
    >`
      select
        exists (
          select 1
          from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'opengeni_private'
        and procedure.proname = 'enforce_app_immutable_rows'
        and pg_catalog.oidvectortypes(procedure.proargtypes) = ''`;
    expect(immutableGuardAcl).toEqual({
      publicExecute: false,
    });
  });

  test("admits only scoped capability calls for the non-owner runtime role", async () => {
    if (!clean) return;
    const actorSubjectId = `human:${crypto.randomUUID()}`;
    const appUrl = runtimeUrl(clean.adminUrl, clean.appPassword);
    const client = createDb(appUrl, { max: 2, rlsStrategy: "force" });
    const rawApp = postgres(appUrl, { max: 1, prepare: false, onnotice: () => undefined });
    try {
      const created = await createWorkspaceApp(client.db, {
        accountId: cleanAccountId,
        workspaceId: cleanWorkspaceId,
        actorSubjectId,
        slug: "live-app",
        title: "Live App",
        idempotencyKey: crypto.randomUUID(),
      });
      expect(created.replayed).toBe(false);

      const own = await listWorkspaceApps(client.db, {
        accountId: cleanAccountId,
        workspaceId: cleanWorkspaceId,
      });
      const other = await listWorkspaceApps(client.db, {
        accountId: cleanAccountId,
        workspaceId: otherWorkspaceId,
      });
      expect(own.apps.map((app) => app.id)).toContain(created.app.id);
      expect(other.apps).toEqual([]);

      const owner = postgres(clean.ownerUrl, {
        max: 1,
        prepare: false,
        onnotice: () => undefined,
      });
      try {
        const ownerRows = await owner<Array<{ id: string }>>`
          select id from apps where id = ${created.app.id}`;
        expect(Array.from(ownerRows)).toEqual([]);
      } finally {
        await owner.end();
      }

      expect(
        await capturedSqlState(
          rawApp`
            insert into apps (
              account_id, workspace_id, slug, title, created_by_subject_id
            ) values (
              ${cleanAccountId}, ${cleanWorkspaceId}, 'direct-dml', 'Direct DML',
              ${actorSubjectId}
            )`,
        ),
      ).toBe("42501");

      expect(
        await capturedSqlState(
          rawApp.begin(async (transaction) => {
            await transaction`select
              set_config('opengeni.account_id', ${cleanAccountId}, true),
              set_config('opengeni.workspace_id', ${cleanWorkspaceId}, true),
              set_config('opengeni.subject_id', ${actorSubjectId}, true)`;
            await transaction`
              select create_workspace_app_command(${transaction.json({
                accountId: cleanAccountId,
                workspaceId: cleanWorkspaceId,
                actorSubjectId: `human:${crypto.randomUUID()}`,
                slug: "actor-mismatch",
                title: "Actor mismatch",
                idempotencyKey: crypto.randomUUID(),
              })}::jsonb)`;
          }),
        ),
      ).toBe("42501");
    } finally {
      await rawApp.end();
      await client.close();
    }
  });

  test("keeps immutable history protected from direct deletion while allowing workspace cascade", async () => {
    if (!clean) return;
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const appId = crypto.randomUUID();
    const sourceRevisionId = crypto.randomUUID();
    const toolPolicyRevisionId = crypto.randomUUID();
    const buildId = crypto.randomUUID();
    const buildFileId = crypto.randomUUID();
    const releaseId = crypto.randomUUID();
    const previewId = crypto.randomUUID();
    const launchId = crypto.randomUUID();
    const actorSubjectId = `human:${crypto.randomUUID()}`;
    const contentSha256 = "1".repeat(64);
    const catalogDigest = "2".repeat(64);
    const manifestSha256 = "3".repeat(64);
    const receiptDigest = "4".repeat(64);
    const nonceSha256 = `sha256:${"5".repeat(64)}`;
    const hostname = `${appId}.apps.example.com`;
    const manifest = {
      version: "opengeni.app-build.v1",
      entryPath: "index.html",
      totalBytes: 1,
      files: [
        {
          path: "index.html",
          contentType: "text/html",
          contentSha256,
          sizeBytes: 1,
          executable: false,
        },
      ],
    };

    await clean.admin.begin(async (transaction) => {
      await transaction`
        insert into managed_accounts (id, name)
        values (${accountId}, ${`apps-cascade-${accountId}`})`;
      await transaction`
        insert into workspaces (id, account_id, name)
        values (${workspaceId}, ${accountId}, ${`apps-cascade-${workspaceId}`})`;
      await transaction`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspaceId}, ${accountId})`;
      await transaction`
        insert into apps (id, account_id, workspace_id, slug, title, created_by_subject_id)
        values (${appId}, ${accountId}, ${workspaceId}, ${`cascade-${appId}`}, 'Cascade app', ${actorSubjectId})`;
      await transaction`
        insert into app_source_revisions (
          id, account_id, workspace_id, app_id, revision, status,
          staging_object_key, frozen_object_key, frozen_version_token,
          content_sha256, size_bytes, file_count, created_by_subject_id, verified_at
        ) values (
          ${sourceRevisionId}, ${accountId}, ${workspaceId}, ${appId}, 1, 'ready',
          ${`apps/${appId}/staging/source.tar`},
          ${`apps/${appId}/frozen/${contentSha256}.tar`}, 'source-version',
          ${contentSha256}, 1, 1, ${actorSubjectId}, clock_timestamp()
        )`;
      await transaction`
        insert into app_tool_policy_revisions (
          id, account_id, workspace_id, app_id, revision, catalog_digest,
          allowed_tools, created_by_subject_id
        ) values (
          ${toolPolicyRevisionId}, ${accountId}, ${workspaceId}, ${appId}, 1,
          ${catalogDigest}, '[]'::jsonb, ${actorSubjectId}
        )`;
      await transaction`
        insert into app_builds (
          id, account_id, workspace_id, app_id, source_revision_id,
          tool_policy_revision_id, revision, status, manifest_object_key,
          manifest_version_token, manifest_sha256, manifest, entry_path,
          file_count, total_bytes, checks, receipt_digest, created_by_subject_id, verified_at
        ) values (
          ${buildId}, ${accountId}, ${workspaceId}, ${appId}, ${sourceRevisionId},
          ${toolPolicyRevisionId}, 1, 'succeeded',
          ${`apps/${appId}/frozen/${manifestSha256}/manifest.json`}, 'manifest-version',
          ${manifestSha256}, ${transaction.json(manifest)}::jsonb, 'index.html', 1, 1,
          ${transaction.json(["manifest", "files", "receipt"])}::jsonb,
          ${receiptDigest}, ${actorSubjectId}, clock_timestamp()
        )`;
      await transaction`
        insert into app_build_files (
          id, account_id, workspace_id, app_id, build_id, path, content_type,
          content_sha256, size_bytes, staging_object_key, frozen_object_key,
          frozen_version_token, frozen_at
        ) values (
          ${buildFileId}, ${accountId}, ${workspaceId}, ${appId}, ${buildId},
          'index.html', 'text/html', ${contentSha256}, 1,
          ${`apps/${appId}/builds/${buildId}/staging/${buildFileId}`},
          ${`apps/${appId}/builds/${buildId}/frozen/${contentSha256}/index.html`},
          'file-version', clock_timestamp()
        )`;
      await transaction`
        insert into app_releases (
          id, account_id, workspace_id, app_id, build_id, source_revision_id,
          tool_policy_revision_id, revision, manifest_sha256, entry_path,
          file_count, total_bytes, build_receipt_digest, created_by_subject_id
        ) values (
          ${releaseId}, ${accountId}, ${workspaceId}, ${appId}, ${buildId},
          ${sourceRevisionId}, ${toolPolicyRevisionId}, 1, ${manifestSha256},
          'index.html', 1, 1, ${receiptDigest}, ${actorSubjectId}
        )`;
      await transaction`
        insert into app_previews (
          id, account_id, workspace_id, app_id, release_id, hostname,
          created_by_subject_id, expires_at
        ) values (
          ${previewId}, ${accountId}, ${workspaceId}, ${appId}, ${releaseId},
          ${hostname}, ${actorSubjectId}, clock_timestamp() + interval '1 hour'
        )`;
      await transaction`
        insert into app_launches (
          id, account_id, workspace_id, app_id, release_id, preview_id,
          hostname, nonce_sha256, authority_generation, expires_at, created_by_subject_id
        ) values (
          ${launchId}, ${accountId}, ${workspaceId}, ${appId}, ${releaseId}, ${previewId},
          ${hostname}, ${nonceSha256}, 'cascade-generation',
          clock_timestamp() + interval '10 minutes', ${actorSubjectId}
        )`;
      await transaction`
        insert into opengeni_private.app_host_routes (
          hostname, nonce_sha256, app_id, release_id, preview_id, launch_id,
          entry_path, spa_fallback, expires_at
        ) values (
          ${hostname}, ${nonceSha256}, ${appId}, ${releaseId}, ${previewId}, ${launchId},
          'index.html', true, clock_timestamp() + interval '10 minutes'
        )`;
    });

    expect(
      await capturedSqlState(
        clean.admin`delete from app_source_revisions where id = ${sourceRevisionId}`,
      ),
    ).toBe("55000");

    await clean.admin.begin(async (transaction) => {
      await transaction`delete from workspaces where id = ${workspaceId}`;
      const [remaining] = await transaction<
        Array<{
          apps: number;
          sources: number;
          policies: number;
          builds: number;
          files: number;
          releases: number;
          previews: number;
          launches: number;
          routes: number;
        }>
      >`
        select
          (select count(*)::int from apps where workspace_id = ${workspaceId}) as apps,
          (select count(*)::int from app_source_revisions where workspace_id = ${workspaceId}) as sources,
          (select count(*)::int from app_tool_policy_revisions where workspace_id = ${workspaceId}) as policies,
          (select count(*)::int from app_builds where workspace_id = ${workspaceId}) as builds,
          (select count(*)::int from app_build_files where workspace_id = ${workspaceId}) as files,
          (select count(*)::int from app_releases where workspace_id = ${workspaceId}) as releases,
          (select count(*)::int from app_previews where workspace_id = ${workspaceId}) as previews,
          (select count(*)::int from app_launches where workspace_id = ${workspaceId}) as launches,
          (select count(*)::int from opengeni_private.app_host_routes where app_id = ${appId}) as routes`;
      expect(remaining).toEqual({
        apps: 0,
        sources: 0,
        policies: 0,
        builds: 0,
        files: 0,
        releases: 0,
        previews: 0,
        launches: 0,
        routes: 0,
      });
    });
    await clean.admin`delete from managed_accounts where id = ${accountId}`;
  });

  test("allows concurrent previews and fences pending tool replays after launch settlement", async () => {
    if (!clean) return;
    const actorSubjectId = `human:${crypto.randomUUID()}`;
    const appId = crypto.randomUUID();
    const sourceRevisionId = crypto.randomUUID();
    const toolPolicyRevisionId = crypto.randomUUID();
    const buildId = crypto.randomUUID();
    const releaseId = crypto.randomUUID();
    const previewId = crypto.randomUUID();
    const revokedLaunchId = crypto.randomUUID();
    const expiredLaunchId = crypto.randomUUID();
    const settledLaunchId = crypto.randomUUID();
    const racedLaunchId = crypto.randomUUID();
    const revokedOperationId = crypto.randomUUID();
    const expiredOperationId = crypto.randomUUID();
    const settledOperationId = crypto.randomUUID();
    const racedOperationId = crypto.randomUUID();
    const sourceSha256 = "a".repeat(64);
    const catalogDigest = "b".repeat(64);
    const manifestSha256 = "c".repeat(64);
    const receiptDigest = "d".repeat(64);
    const launchNonceSha256 = `sha256:${"e".repeat(64)}`;
    const expiredLaunchNonceSha256 = `sha256:${"f".repeat(64)}`;
    const settledLaunchNonceSha256 = `sha256:${"0".repeat(64)}`;
    const racedLaunchNonceSha256 = `sha256:${"3".repeat(64)}`;
    const authorityGeneration = `generation-${crypto.randomUUID()}`;
    const inputHash = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
    const hostname = `${appId}.apps.example.com`;
    const manifest = {
      version: "opengeni.app-build.v1",
      entryPath: "index.html",
      totalBytes: 1,
      files: [
        {
          path: "index.html",
          contentType: "text/html",
          contentSha256: sourceSha256,
          sizeBytes: 1,
          executable: false,
        },
      ],
    };

    await clean.admin.begin(async (transaction) => {
      await transaction`
        insert into apps (
          id, account_id, workspace_id, slug, title, created_by_subject_id
        ) values (
          ${appId}, ${cleanAccountId}, ${cleanWorkspaceId},
          ${`replay-${appId}`}, 'Replay fixture', ${actorSubjectId}
        )`;
      await transaction`
        insert into app_source_revisions (
          id, account_id, workspace_id, app_id, revision, status,
          staging_object_key, frozen_object_key, frozen_version_token,
          content_sha256, size_bytes, file_count, created_by_subject_id, verified_at
        ) values (
          ${sourceRevisionId}, ${cleanAccountId}, ${cleanWorkspaceId}, ${appId}, 1, 'ready',
          ${`apps/${appId}/staging/source.tar`},
          ${`apps/${appId}/frozen/${sourceSha256}.tar`}, 'source-version',
          ${sourceSha256}, 1, 1, ${actorSubjectId}, clock_timestamp()
        )`;
      await transaction`
        insert into app_tool_policy_revisions (
          id, account_id, workspace_id, app_id, revision, catalog_digest,
          allowed_tools, created_by_subject_id
        ) values (
          ${toolPolicyRevisionId}, ${cleanAccountId}, ${cleanWorkspaceId}, ${appId}, 1,
          ${catalogDigest},
          ${transaction.json([{ serverId: "docs", toolName: "memory_search" }])}::jsonb,
          ${actorSubjectId}
        )`;
      await transaction`
        insert into app_builds (
          id, account_id, workspace_id, app_id, source_revision_id,
          tool_policy_revision_id, revision, status, manifest_object_key,
          manifest_version_token, manifest_sha256, manifest, entry_path,
          file_count, total_bytes, checks, receipt_digest, created_by_subject_id, verified_at
        ) values (
          ${buildId}, ${cleanAccountId}, ${cleanWorkspaceId}, ${appId}, ${sourceRevisionId},
          ${toolPolicyRevisionId}, 1, 'succeeded',
          ${`apps/${appId}/frozen/${manifestSha256}/manifest.json`}, 'manifest-version',
          ${manifestSha256}, ${transaction.json(manifest)}::jsonb, 'index.html', 1, 1,
          ${transaction.json(["manifest", "files", "receipt"])}::jsonb,
          ${receiptDigest}, ${actorSubjectId}, clock_timestamp()
        )`;
      await transaction`
        insert into app_releases (
          id, account_id, workspace_id, app_id, build_id, source_revision_id,
          tool_policy_revision_id, revision, manifest_sha256, entry_path,
          file_count, total_bytes, build_receipt_digest, created_by_subject_id
        ) values (
          ${releaseId}, ${cleanAccountId}, ${cleanWorkspaceId}, ${appId}, ${buildId},
          ${sourceRevisionId}, ${toolPolicyRevisionId}, 1, ${manifestSha256},
          'index.html', 1, 1, ${receiptDigest}, ${actorSubjectId}
        )`;
      await transaction`
        insert into app_previews (
          id, account_id, workspace_id, app_id, release_id, hostname,
          created_by_subject_id, expires_at
        ) values (
          ${previewId}, ${cleanAccountId}, ${cleanWorkspaceId}, ${appId}, ${releaseId},
          ${hostname}, ${actorSubjectId}, clock_timestamp() + interval '1 hour'
        )`;
      await transaction`
        insert into app_launches (
          id, account_id, workspace_id, app_id, release_id, preview_id,
          hostname, nonce_sha256, authority_generation, status, expires_at,
          revoked_at, created_by_subject_id
        ) values
          (
            ${revokedLaunchId}, ${cleanAccountId}, ${cleanWorkspaceId}, ${appId},
            ${releaseId}, ${previewId}, ${hostname}, ${launchNonceSha256},
            ${authorityGeneration}, 'revoked', clock_timestamp() + interval '10 minutes',
            clock_timestamp(), ${actorSubjectId}
          ),
          (
            ${expiredLaunchId}, ${cleanAccountId}, ${cleanWorkspaceId}, ${appId},
            ${releaseId}, ${previewId}, ${hostname}, ${expiredLaunchNonceSha256},
            ${authorityGeneration}, 'active', clock_timestamp() - interval '1 second',
            null, ${actorSubjectId}
          ),
          (
            ${settledLaunchId}, ${cleanAccountId}, ${cleanWorkspaceId}, ${appId},
            ${releaseId}, ${previewId}, ${hostname}, ${settledLaunchNonceSha256},
            ${authorityGeneration}, 'revoked', clock_timestamp() + interval '10 minutes',
            clock_timestamp(), ${actorSubjectId}
          )`;
      await transaction`
        insert into app_tool_calls (
          account_id, workspace_id, app_id, release_id, launch_id, operation_id,
          tool_server_id, tool_name, catalog_digest, input_hash, status,
          output, created_by_subject_id, settled_at
        ) values
          (
            ${cleanAccountId}, ${cleanWorkspaceId}, ${appId}, ${releaseId},
            ${revokedLaunchId}, ${revokedOperationId}, 'docs', 'memory_search',
            ${catalogDigest}, ${inputHash}, 'pending', null, ${actorSubjectId}, null
          ),
          (
            ${cleanAccountId}, ${cleanWorkspaceId}, ${appId}, ${releaseId},
            ${expiredLaunchId}, ${expiredOperationId}, 'docs', 'memory_search',
            ${catalogDigest}, ${inputHash}, 'pending', null, ${actorSubjectId}, null
          ),
          (
            ${cleanAccountId}, ${cleanWorkspaceId}, ${appId}, ${releaseId},
            ${settledLaunchId}, ${settledOperationId}, 'docs', 'memory_search',
            ${catalogDigest}, ${inputHash}, 'succeeded', ${transaction.json({ ok: true })}::jsonb,
            ${actorSubjectId}, clock_timestamp()
          )`;
    });

    const appUrl = runtimeUrl(clean.adminUrl, clean.appPassword);
    const client = createDb(appUrl, { max: 2, rlsStrategy: "force" });
    const rawApp = postgres(appUrl, { max: 1, prepare: false, onnotice: () => undefined });
    const rawAdmin = postgres(clean.adminUrl, {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    const beginCommand = (launchId: string, launchDigest: string, operationId: string) => ({
      action: "begin",
      accountId: cleanAccountId,
      workspaceId: cleanWorkspaceId,
      actorSubjectId,
      appId,
      releaseId,
      launchId,
      launchNonceSha256: launchDigest,
      authorityHash: null,
      authorityEpoch: null,
      authorityGeneration,
      operationId,
      identity: { serverId: "docs", toolName: "memory_search" },
      catalogDigest,
      input: {},
    });
    const beginState = async (command: ReturnType<typeof beginCommand>, lockTimeout = false) =>
      await capturedSqlState(
        rawApp.begin(async (transaction) => {
          await transaction`select
            set_config('opengeni.account_id', ${cleanAccountId}, true),
            set_config('opengeni.workspace_id', ${cleanWorkspaceId}, true),
            set_config('opengeni.subject_id', ${actorSubjectId}, true),
            set_config('lock_timeout', ${lockTimeout ? "100ms" : "0"}, true)`;
          await transaction`
            select app_tool_call_command(${transaction.json(command)}::jsonb)`;
        }),
      );
    const replayState = async (command: ReturnType<typeof beginCommand>) =>
      await beginState(command);
    const launchCommand = (targetPreviewId: string, nonceDigit: string) => ({
      accountId: cleanAccountId,
      workspaceId: cleanWorkspaceId,
      actorSubjectId,
      appId,
      releaseId,
      previewId: targetPreviewId,
      launchId: crypto.randomUUID(),
      nonceSha256: `sha256:${nonceDigit.repeat(64)}`,
      expiresAt: new Date(Date.now() + 5 * 60 * 1_000).toISOString(),
      authorityHash: null,
      authorityEpoch: null,
      authorityGeneration,
    });
    const previewCommand = () => ({
      accountId: cleanAccountId,
      workspaceId: cleanWorkspaceId,
      actorSubjectId,
      appId,
      releaseId,
      hostname,
      expiresAt: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
      spaFallback: true,
      idempotencyKey: crypto.randomUUID(),
    });
    const launchState = async (command: ReturnType<typeof launchCommand>, lockTimeout: boolean) =>
      await capturedSqlState(
        rawApp.begin(async (transaction) => {
          await transaction`select
            set_config('opengeni.account_id', ${cleanAccountId}, true),
            set_config('opengeni.workspace_id', ${cleanWorkspaceId}, true),
            set_config('opengeni.subject_id', ${actorSubjectId}, true),
            set_config('lock_timeout', ${lockTimeout ? "100ms" : "0"}, true)`;
          await transaction`
            select app_launch_command(${transaction.json(command)}::jsonb)`;
        }),
      );
    const previewState = async (command: ReturnType<typeof previewCommand>, lockTimeout: boolean) =>
      await capturedSqlState(
        rawApp.begin(async (transaction) => {
          await transaction`select
            set_config('opengeni.account_id', ${cleanAccountId}, true),
            set_config('opengeni.workspace_id', ${cleanWorkspaceId}, true),
            set_config('opengeni.subject_id', ${actorSubjectId}, true),
            set_config('lock_timeout', ${lockTimeout ? "100ms" : "0"}, true)`;
          await transaction`
            select create_app_preview_command(${transaction.json(command)}::jsonb)`;
        }),
      );

    try {
      const firstPreview = await createAppPreview(client.db, {
        accountId: cleanAccountId,
        workspaceId: cleanWorkspaceId,
        actorSubjectId,
        appId,
        releaseId,
        hostname,
        expiresAt: new Date(Date.now() + 30 * 60 * 1_000),
        idempotencyKey: crypto.randomUUID(),
      });
      const secondPreview = await createAppPreview(client.db, {
        accountId: cleanAccountId,
        workspaceId: cleanWorkspaceId,
        actorSubjectId,
        appId,
        releaseId,
        hostname,
        expiresAt: new Date(Date.now() + 45 * 60 * 1_000),
        idempotencyKey: crypto.randomUUID(),
      });
      expect(firstPreview.preview.id).not.toBe(secondPreview.preview.id);
      await clean.admin`
        insert into app_launches (
          id, account_id, workspace_id, app_id, release_id, preview_id,
          hostname, nonce_sha256, authority_generation, status, expires_at,
          created_by_subject_id
        ) values (
          ${racedLaunchId}, ${cleanAccountId}, ${cleanWorkspaceId}, ${appId},
          ${releaseId}, ${firstPreview.preview.id}, ${hostname}, ${racedLaunchNonceSha256},
          ${authorityGeneration}, 'active', clock_timestamp() + interval '10 minutes',
          ${actorSubjectId}
        )`;
      const [activePreviews] = await clean.admin<Array<{ count: number }>>`
        select count(*)::int as count from app_previews
        where workspace_id = ${cleanWorkspaceId} and app_id = ${appId}
          and hostname = ${hostname} and status = 'active'`;
      expect(activePreviews).toEqual({ count: 3 });

      expect(
        await replayState(beginCommand(revokedLaunchId, launchNonceSha256, revokedOperationId)),
      ).toBe("P0002");
      expect(
        await replayState(
          beginCommand(expiredLaunchId, expiredLaunchNonceSha256, expiredOperationId),
        ),
      ).toBe("P0002");

      const [settledReplay] = await rawApp.begin(async (transaction) => {
        await transaction`select
          set_config('opengeni.account_id', ${cleanAccountId}, true),
          set_config('opengeni.workspace_id', ${cleanWorkspaceId}, true),
          set_config('opengeni.subject_id', ${actorSubjectId}, true)`;
        return await transaction<
          Array<{ result: { replayed: boolean; toolCall: { status: string } } }>
        >`
          select app_tool_call_command(${transaction.json(
            beginCommand(settledLaunchId, settledLaunchNonceSha256, settledOperationId),
          )}::jsonb) as result`;
      });
      expect(settledReplay!.result).toMatchObject({
        replayed: true,
        toolCall: { status: "succeeded" },
      });

      let releaseRacedRevoke!: () => void;
      let markRacedRevokeReady!: () => void;
      const racedRevokeGate = new Promise<void>((resolve) => {
        releaseRacedRevoke = resolve;
      });
      const racedRevokeReady = new Promise<void>((resolve) => {
        markRacedRevokeReady = resolve;
      });
      const racedRevokeBlocker = rawAdmin.begin(async (transaction) => {
        await transaction`select
          set_config('opengeni.account_id', ${cleanAccountId}, true),
          set_config('opengeni.workspace_id', ${cleanWorkspaceId}, true),
          set_config('opengeni.subject_id', ${actorSubjectId}, true)`;
        await transaction`
          select revoke_app_preview_command(${transaction.json({
            accountId: cleanAccountId,
            workspaceId: cleanWorkspaceId,
            actorSubjectId,
            appId,
            previewId: firstPreview.preview.id,
            reason: "concurrent tool begin regression",
            idempotencyKey: crypto.randomUUID(),
          })}::jsonb)`;
        markRacedRevokeReady();
        await racedRevokeGate;
      });
      await racedRevokeReady;
      let racedBeginState: string | null;
      try {
        racedBeginState = await beginState(
          beginCommand(racedLaunchId, racedLaunchNonceSha256, racedOperationId),
          true,
        );
      } finally {
        releaseRacedRevoke();
        await racedRevokeBlocker;
      }
      expect(racedBeginState).toBe("55P03");
      expect(
        await beginState(beginCommand(racedLaunchId, racedLaunchNonceSha256, racedOperationId)),
      ).toBe("P0002");

      const revokeLaunch = launchCommand(previewId, "1");
      let releaseRevoke!: () => void;
      let markRevokeReady!: () => void;
      const revokeGate = new Promise<void>((resolve) => {
        releaseRevoke = resolve;
      });
      const revokeReady = new Promise<void>((resolve) => {
        markRevokeReady = resolve;
      });
      const revokeBlocker = rawAdmin.begin(async (transaction) => {
        await transaction`select
          set_config('opengeni.account_id', ${cleanAccountId}, true),
          set_config('opengeni.workspace_id', ${cleanWorkspaceId}, true),
          set_config('opengeni.subject_id', ${actorSubjectId}, true)`;
        await transaction`
          select revoke_app_preview_command(${transaction.json({
            accountId: cleanAccountId,
            workspaceId: cleanWorkspaceId,
            actorSubjectId,
            appId,
            previewId,
            reason: "concurrent launch regression",
            idempotencyKey: crypto.randomUUID(),
          })}::jsonb)`;
        markRevokeReady();
        await revokeGate;
      });
      await revokeReady;
      let revokeLaunchState: string | null;
      try {
        revokeLaunchState = await launchState(revokeLaunch, true);
      } finally {
        releaseRevoke();
        await revokeBlocker;
      }
      expect(revokeLaunchState).toBe("55P03");
      expect(await launchState(revokeLaunch, false)).toBe("P0002");

      const archivePreview = await createAppPreview(client.db, {
        accountId: cleanAccountId,
        workspaceId: cleanWorkspaceId,
        actorSubjectId,
        appId,
        releaseId,
        hostname,
        expiresAt: new Date(Date.now() + 30 * 60 * 1_000),
        idempotencyKey: crypto.randomUUID(),
      });
      const archiveLaunch = launchCommand(archivePreview.preview.id, "2");
      const concurrentPreview = previewCommand();
      let releaseArchive!: () => void;
      let markArchiveReady!: () => void;
      const archiveGate = new Promise<void>((resolve) => {
        releaseArchive = resolve;
      });
      const archiveReady = new Promise<void>((resolve) => {
        markArchiveReady = resolve;
      });
      const archiveBlocker = rawAdmin.begin(async (transaction) => {
        await transaction`select
          set_config('opengeni.account_id', ${cleanAccountId}, true),
          set_config('opengeni.workspace_id', ${cleanWorkspaceId}, true),
          set_config('opengeni.subject_id', ${actorSubjectId}, true)`;
        await transaction`
          select archive_workspace_app_command(${transaction.json({
            accountId: cleanAccountId,
            workspaceId: cleanWorkspaceId,
            actorSubjectId,
            appId,
            expectedAppVersion: 1,
            reason: "concurrent creation regression",
            idempotencyKey: crypto.randomUUID(),
          })}::jsonb)`;
        markArchiveReady();
        await archiveGate;
      });
      await archiveReady;
      let archivePreviewState: string | null;
      let archiveLaunchState: string | null;
      try {
        archivePreviewState = await previewState(concurrentPreview, true);
        archiveLaunchState = await launchState(archiveLaunch, true);
      } finally {
        releaseArchive();
        await archiveBlocker;
      }
      expect(archivePreviewState).toBe("55P03");
      expect(archiveLaunchState).toBe("55P03");
      expect(await previewState(concurrentPreview, false)).toBe("P0002");
      expect(await launchState(archiveLaunch, false)).toBe("P0002");

      const [servingReferences] = await rawAdmin<
        Array<{ previews: number; launches: number; routes: number }>
      >`
        select
          (select count(*)::int from app_previews
            where workspace_id = ${cleanWorkspaceId} and app_id = ${appId}
              and status = 'active') as previews,
          (select count(*)::int from app_launches
            where workspace_id = ${cleanWorkspaceId} and app_id = ${appId}
              and status = 'active') as launches,
          (select count(*)::int from opengeni_private.app_host_routes
            where app_id = ${appId}) as routes`;
      expect(servingReferences).toEqual({ previews: 0, launches: 0, routes: 0 });
    } finally {
      await rawAdmin.end();
      await rawApp.end();
      await client.close();
    }
  }, 900_000);

  test("upgrades a pre-0382 database without changing existing HTML Artifacts", async () => {
    if (!upgrade) return;
    const [artifact] = await upgrade.admin<
      Array<{ id: string; slug: string; title: string; status: string }>
    >`
      select id, slug, title, status from workspace_artifacts where id = ${upgradedArtifactId}`;
    expect(artifact).toEqual({
      id: upgradedArtifactId,
      slug: "legacy-html",
      title: "Legacy HTML",
      status: "active",
    });
    const [appsTable] = await upgrade.admin<Array<{ present: boolean }>>`
      select to_regclass('public.apps') is not null as present`;
    expect(appsTable).toEqual({ present: true });
    const [migration] = await upgrade.admin<Array<{ count: number }>>`
      select count(*)::int as count from schema_migrations where name = ${migrationName}`;
    expect(migration).toEqual({ count: 1 });
  });
});

async function acquireAppsOwnerDatabase(label: string): Promise<OwnerMigratedTestDatabase | null> {
  if (!externalAdminUrl) return await acquireOwnerMigratedTestDatabase(label);

  const databaseName = `og_${label.replace(/[^a-z0-9]/giu, "_").slice(0, 24)}_${crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;
  const ownerRole = `${databaseName}_owner`.slice(0, 63);
  const ownerPassword = crypto.randomUUID().replaceAll("-", "");
  const rootUrl = new URL(externalAdminUrl);
  rootUrl.pathname = "/postgres";
  const root = postgres(rootUrl.toString(), {
    max: 1,
    prepare: false,
    onnotice: () => undefined,
  });
  let admin: postgres.Sql | null = null;
  try {
    await root.unsafe(
      `CREATE ROLE ${quoteIdentifier(ownerRole)} WITH LOGIN NOSUPERUSER NOBYPASSRLS ` +
        `NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD '${ownerPassword}'`,
    );
    await root.unsafe(
      `CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER ${quoteIdentifier(ownerRole)}`,
    );
    await root.end();

    const adminUrl = new URL(externalAdminUrl);
    adminUrl.pathname = `/${databaseName}`;
    admin = postgres(adminUrl.toString(), {
      max: 2,
      prepare: false,
      onnotice: () => undefined,
    });
    await admin.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await admin.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
    await admin.unsafe(`GRANT CREATE, USAGE ON SCHEMA public TO ${quoteIdentifier(ownerRole)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.username = ownerRole;
    ownerUrl.password = ownerPassword;
    let released = false;
    return {
      ownerUrl: ownerUrl.toString(),
      ownerRole,
      adminUrl: adminUrl.toString(),
      admin,
      appPassword: externalAppPassword,
      release: async () => {
        if (released) return;
        released = true;
        await admin?.end().catch(() => undefined);
        const cleanup = postgres(rootUrl.toString(), {
          max: 1,
          prepare: false,
          onnotice: () => undefined,
        });
        await cleanup
          .unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`)
          .catch(() => undefined);
        await cleanup
          .unsafe(`DROP ROLE IF EXISTS ${quoteIdentifier(ownerRole)}`)
          .catch(() => undefined);
        await cleanup.end().catch(() => undefined);
      },
    };
  } catch (error) {
    await admin?.end().catch(() => undefined);
    await root.end().catch(() => undefined);
    const cleanup = postgres(rootUrl.toString(), {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    await cleanup
      .unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`)
      .catch(() => undefined);
    await cleanup
      .unsafe(`DROP ROLE IF EXISTS ${quoteIdentifier(ownerRole)}`)
      .catch(() => undefined);
    await cleanup.end().catch(() => undefined);
    throw error;
  }
}

function runtimeUrl(adminUrl: string, password: string): string {
  const url = new URL(adminUrl);
  url.username = "opengeni_app";
  url.password = password;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error(`Invalid test database identifier: ${value}`);
  }
  return `"${value}"`;
}

async function capturedSqlState(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return nestedPostgresSqlState(error);
  }
}
