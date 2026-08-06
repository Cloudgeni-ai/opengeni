import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  assertRuntimeDatabasePosture,
  claimRetainedScreenshotMaintenance,
  claimSessionWorkForAttempt,
  createApiKey,
  createDb,
  createSession,
  FORCE_RLS_TABLES,
  initializeSessionStartAtomically,
  listApiKeys,
  prepareRetainedScreenshotArtifact,
  PROTECTED_NO_DIRECT_DML_TABLES,
  RUNTIME_FULL_DML_TABLES,
  rlsStrategyFor,
  withWorkspaceRls,
  type Database,
  type DbClient,
} from "../src/index";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

// The decisive migration-replay and RLS-isolation proof that the existing
// suites do NOT cover: a NON-OWNER role (`opengeni_app`) under FORCE RLS, in a
// DEDICATED schema (NOT public), reading through the REAL packages/db query path
// (createDb searchPath + withWorkspaceRls GUCs + provisionRoles grants).
//
// This closes the exact silent-failure hazard: under a dedicated schema, does a
// tenant-scoped query actually ISOLATE, or does it silently hit `public`/leak
// across tenants? We prove:
//   (A) the embedded migrate+provision SDK path lands tables/policies in the
//       dedicated schema only (0 in public), confirming idempotent schema isolation.
//   (B) rows written under workspace A's RLS context LAND IN THE DEDICATED SCHEMA
//       (verified by a superuser read of <schema>.api_keys), NOT silently in public.
//   (C) a cross-tenant read under workspace B's RLS context returns ZERO of A's
//       rows — RLS genuinely isolates under the non-owner role + dedicated schema.
//   (D) each tenant sees exactly its own rows under its own context.
//   (E) the handle's bound strategy is "force".
//
// By default this uses a throwaway pgvector pg17 Docker container on a
// non-default port and tears it down in afterAll. Environments without Docker
// may point OPENGENI_TEST_THROWAWAY_DATABASE_ADMIN_URL at an equally disposable
// PostgreSQL database with pgvector installed; this test applies every migration
// and creates/normalizes roles, so a shared or persistent database is unsafe.

// Fixed Docker listeners stay above Linux's default ephemeral client-port range;
// the container name binds the listener contract across worktrees.
const PORT = 61441;
const CONTAINER = `ogverify-pg-rls-dedicated-${PORT}`;
const PASSWORD = "x";
const APP_PASSWORD = "apppw";
const SCHEMA = "tenantx";
const EXTERNAL_ADMIN_URL = process.env.OPENGENI_TEST_THROWAWAY_DATABASE_ADMIN_URL?.trim();
const ADMIN_URL =
  EXTERNAL_ADMIN_URL || `postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres`;
const appUrl = new URL(ADMIN_URL);
appUrl.username = "opengeni_app";
appUrl.password = APP_PASSWORD;
const APP_URL = appUrl.toString();
const SEARCH_PATH = `${SCHEMA},opengeni_private,public`;
const IMAGE = "pgvector/pgvector:pg17";
const lifecycleMigrationUrl = new URL(
  "../drizzle/0180_retained_screenshot_lifecycle_fences.sql",
  import.meta.url,
);

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function removeContainer(): void {
  try {
    docker(["rm", "-f", "-v", CONTAINER]);
  } catch {
    // already gone
  }
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      const probe = postgres(ADMIN_URL, { max: 1, connect_timeout: 2 });
      try {
        await probe`SELECT 1`;
        return;
      } finally {
        await probe.end();
      }
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`postgres did not become ready in time: ${String(err)}`, { cause: err });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

let available = true;
let dockerStarted = false;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

// Seed a fresh (account, workspace) as the superuser (bypasses RLS) directly in
// the dedicated schema. We MUST schema-qualify because the admin connection's
// search_path is the server default (public).
async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  return await freshWorkspaceIn(admin, SCHEMA);
}

async function freshWorkspaceIn(
  targetAdmin: postgres.Sql,
  schemaName: string,
): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await targetAdmin<{ id: string }[]>`
    insert into ${targetAdmin(schemaName)}.managed_accounts (name) values ('acct') returning id`;
  const [w] = await targetAdmin<{ id: string }[]>`
    insert into ${targetAdmin(schemaName)}.workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  await targetAdmin`
    insert into ${targetAdmin(schemaName)}.workspace_inference_controls (workspace_id, account_id)
    values (${w!.id}, ${a!.id})`;
  return { accountId: a!.id, workspaceId: w!.id };
}

async function prepareClaimableScreenshot(
  targetDb: Database,
  targetAdmin: postgres.Sql,
  schemaName: string,
): Promise<{ artifactId: string; workspaceId: string }> {
  const workspace = await freshWorkspaceIn(targetAdmin, schemaName);
  const session = await createSession(targetDb, {
    ...workspace,
    initialMessage: "claim a retained screenshot",
    resources: [],
    metadata: {},
    model: "dedicated-schema-test",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(targetDb, {
    ...workspace,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(targetDb, workspace.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `retained-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`fixture claim failed: ${claimed.reason}`);
  const artifactId = crypto.randomUUID();
  await prepareRetainedScreenshotArtifact(targetDb, {
    artifactId,
    ...workspace,
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    settlementKey: `dedicated:${artifactId}`,
    toolCallId: `call-${artifactId}`,
    toolOutputId: `output-${artifactId}`,
    mediaType: "image/png",
    sizeBytes: 4,
    sha256: "a".repeat(64),
    width: 1,
    height: 1,
    retentionExpiresAt: new Date(Date.now() + 60_000),
    bucket: "dedicated-schema-test",
    objectKey: `workspaces/${workspace.workspaceId}/files/${artifactId}/retained/screenshot.png`,
    workspaceQuotaBytes: 1024,
  });
  return { artifactId, workspaceId: workspace.workspaceId };
}

beforeAll(async () => {
  if (!EXTERNAL_ADMIN_URL) {
    try {
      removeContainer();
      docker([
        "run",
        "--rm",
        "-d",
        "-e",
        `POSTGRES_PASSWORD=${PASSWORD}`,
        "-p",
        `${PORT}:5432`,
        "--name",
        CONTAINER,
        IMAGE,
      ]);
      dockerStarted = true;
    } catch (err) {
      available = false;
      console.warn(`[rls-dedicated] docker unavailable, skipping: ${String(err)}`);
      return;
    }
  }
  await waitForReady();

  // (A) embedded migrate into the dedicated schema via the SDK entry point.
  await migrate(ADMIN_URL, SCHEMA);
  await migrate(ADMIN_URL, SCHEMA);

  // Provision the non-owner app role via the REAL provisionRoles SDK entry, in
  // FORCE strategy, against the dedicated schema. This GRANTs opengeni_app DML on
  // <schema>.* + EXECUTE on opengeni_private.* — the role openGeni connects as so
  // FORCE RLS is genuinely enforced (a superuser would bypass it).
  await provisionRoles(ADMIN_URL, {
    targetSchema: SCHEMA,
    rlsStrategy: "force",
    appRole: "opengeni_app",
    appPassword: APP_PASSWORD,
  });

  admin = postgres(ADMIN_URL, { max: 4 });

  // createDb with the dedicated-schema search_path + force strategy — the exact
  // embedded handle shape (minus userLookup).
  client = createDb(APP_URL, { max: 1, searchPath: SEARCH_PATH, rlsStrategy: "force" });
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  try {
    await admin?.end();
  } catch {
    /* noop */
  }
  if (dockerStarted) {
    removeContainer();
  }
});

describe("migration replay — RLS isolation under a DEDICATED schema + NON-OWNER role", () => {
  test("runtime identity and every declared tenant table satisfy the exact FORCE-RLS posture", async () => {
    if (!available) return;
    const posture = await assertRuntimeDatabasePosture(db, {
      rlsStrategy: "force",
      expectedRole: "opengeni_app",
      targetSchema: SCHEMA,
    });

    expect(posture.identity).toMatchObject({
      currentUser: "opengeni_app",
      sessionUser: "opengeni_app",
      canLogin: true,
      superuser: false,
      inherit: false,
      createRole: false,
      createDatabase: false,
      replication: false,
      bypassRls: false,
      canCreateInDatabase: false,
      rowSecurity: "on",
    });
    expect(posture.memberships).toEqual([]);
    expect(posture.ownedSchemas).toEqual([]);
    expect(posture.ownedRelations).toEqual([]);
    expect(posture.tables.filter((table) => table.rlsEnabled)).toHaveLength(
      FORCE_RLS_TABLES.length,
    );
    expect(posture.tables.filter((table) => table.rlsActive)).toHaveLength(FORCE_RLS_TABLES.length);
    expect(
      posture.tables.filter(
        (table) => table.select && table.insert && table.update && table.delete,
      ),
    ).toHaveLength(RUNTIME_FULL_DML_TABLES.length);
    expect(
      posture.tables.find((table) => table.name === "nested_agent_depth_configuration"),
    ).toMatchObject({ select: true, insert: false, update: false, delete: false });
    expect(posture.tables.find((table) => table.name === "session_spawn_denials")).toMatchObject({
      select: true,
      insert: true,
      update: false,
      delete: false,
    });
    expect(
      posture.tables.find((table) => table.name === "preference_registry_events"),
    ).toMatchObject({
      select: true,
      insert: false,
      update: false,
      delete: false,
    });
    expect(
      posture.tables.find((table) => table.name === "preference_registry_snapshots"),
    ).toMatchObject({
      select: true,
      insert: false,
      update: false,
      delete: false,
    });
    for (const tableName of [
      "preference_registry_preferences",
      "preference_registry_revisions",
      "workspace_instruction_policy_activation_events",
      "workspace_instruction_policy_revisions",
    ]) {
      expect(posture.tables.find((table) => table.name === tableName)).toMatchObject({
        select: true,
        insert: true,
        update: false,
        delete: false,
      });
    }
    expect(posture.tables.find((table) => table.name === "knowledge_memories")).toMatchObject({
      select: true,
      insert: true,
      update: true,
      delete: true,
    });
    for (const tableName of [
      "knowledge_lifecycle_events",
      "knowledge_memory_lifecycle_events",
      "knowledge_memory_relationships",
    ]) {
      expect(posture.tables.find((table) => table.name === tableName)).toMatchObject({
        select: true,
        insert: false,
        update: false,
        delete: false,
      });
    }
    for (const tableName of [
      "knowledge_change_proposals",
      "knowledge_claim_evidence",
      "knowledge_claim_relations",
      "knowledge_claim_reviews",
      "knowledge_claims",
      "knowledge_document_versions",
      "knowledge_entities",
      "knowledge_entity_aliases",
      "knowledge_facts",
      "knowledge_providers",
      "knowledge_source_acl_versions",
      "knowledge_source_objects",
      "knowledge_sources",
      "knowledge_sync_runs",
    ]) {
      expect(posture.tables.find((table) => table.name === tableName)).toMatchObject({
        select: true,
        insert: true,
        update: false,
        delete: false,
      });
    }
    for (const tableName of PROTECTED_NO_DIRECT_DML_TABLES) {
      expect(posture.tables.find((table) => table.name === tableName)).toMatchObject({
        rlsEnabled: true,
        rlsForced: true,
        rlsActive: true,
        select: false,
        insert: false,
        update: false,
        delete: false,
      });
    }
    expect(
      posture.tables.every((table) => !table.truncate && !table.references && !table.trigger),
    ).toBe(true);
    expect(posture.tables.find((table) => table.name === "schema_migrations")).toMatchObject({
      select: false,
      insert: false,
      update: false,
      delete: false,
    });
    expect(
      posture.tables.find((table) => table.name === "session_history_items_repair_audit"),
    ).toMatchObject({ select: false, insert: false, update: false, delete: false });

    const [preferenceFunctions] = await admin<
      Array<{
        lock_execute: boolean;
        lifecycle_execute: boolean;
        snapshot_execute: boolean;
      }>
    >`
      SELECT
        has_function_privilege(
          'opengeni_app',
          ${`${SCHEMA}.preference_registry_lock_heads(uuid[])`},
          'EXECUTE'
        ) AS lock_execute,
        has_function_privilege(
          'opengeni_app',
          ${`${SCHEMA}.preference_registry_apply_lifecycle(text,uuid,integer,uuid,uuid,text,uuid,text,text)`},
          'EXECUTE'
        ) AS lifecycle_execute,
        has_function_privilege(
          'opengeni_app',
          ${`${SCHEMA}.preference_registry_get_or_create_snapshot(uuid,uuid,uuid,uuid,uuid,integer)`},
          'EXECUTE'
        ) AS snapshot_execute`;
    expect(preferenceFunctions).toEqual({
      lock_execute: true,
      lifecycle_execute: true,
      snapshot_execute: true,
    });

    const knowledgeFunctions = await admin<
      Array<{
        name: string;
        security_definer: boolean;
        app_execute: boolean;
        public_execute: boolean;
        settings: string[] | null;
      }>
    >`
      SELECT
        procedure.proname AS name,
        procedure.prosecdef AS security_definer,
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') AS app_execute,
        exists (
          select 1
          from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) AS public_execute,
        procedure.proconfig AS settings
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = ${SCHEMA}
        AND procedure.proname IN (
          'scoped_knowledge_apply_lifecycle',
          'scoped_knowledge_advance_source_acl',
          'scoped_knowledge_complete_sync',
          'scoped_knowledge_advance_object_version',
          'scoped_knowledge_guard_acl_insert',
          'scoped_knowledge_guard_sync_insert',
          'scoped_knowledge_guard_version_insert'
        )
      ORDER BY procedure.proname`;
    expect(knowledgeFunctions).toHaveLength(7);
    for (const routine of knowledgeFunctions) {
      expect(routine.security_definer).toBe(true);
      expect(routine.public_execute).toBe(false);
      expect(routine.settings).toContain(`search_path=${SCHEMA}, pg_catalog`);
      expect(routine.app_execute).toBe(!routine.name.includes("_guard_"));
    }
  });

  test("the restricted runtime role can perform Better Auth table DML", async () => {
    if (!available) return;
    const userId = `posture-auth-${crypto.randomUUID()}`;
    const email = `${userId}@example.test`;
    await db.execute(sql`
      insert into auth_users (id, name, email)
      values (${userId}, 'Runtime posture test', ${email})
    `);
    const rows = (await db.execute(sql`
      select id, email from auth_users where id = ${userId}
    `)) as unknown as Array<{ id: string; email: string }>;
    expect(rows).toEqual([{ id: userId, email }]);
    await db.execute(sql`delete from auth_users where id = ${userId}`);
  });

  test("clean install securely claims dedicated-schema screenshots as the FORCE-RLS app role", async () => {
    if (!available) return;
    await admin.unsafe(`
      REVOKE CREATE ON SCHEMA ${quoteIdentifier(SCHEMA)} FROM opengeni_app;
      REVOKE CREATE ON SCHEMA opengeni_private FROM opengeni_app;
      REVOKE CREATE ON SCHEMA public FROM opengeni_app;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    `);
    const [privileges] = await admin<
      Array<{ targetCreate: boolean; privateCreate: boolean; publicCreate: boolean }>
    >`
      SELECT
        has_schema_privilege('opengeni_app', ${SCHEMA}, 'CREATE') AS "targetCreate",
        has_schema_privilege('opengeni_app', 'opengeni_private', 'CREATE') AS "privateCreate",
        has_schema_privilege('opengeni_app', 'public', 'CREATE') AS "publicCreate"`;
    expect(privileges).toEqual({
      targetCreate: false,
      privateCreate: false,
      publicCreate: false,
    });

    const fixture = await prepareClaimableScreenshot(db, admin, SCHEMA);
    const claims = await claimRetainedScreenshotMaintenance(db, {
      pendingGraceMs: 0,
      claimTimeoutMs: 60_000,
      limit: 10,
    });
    expect(claims.find((claim) => claim.artifactId === fixture.artifactId)).toMatchObject({
      action: "reconcile",
      workspaceId: fixture.workspaceId,
    });

    const [routine] = await admin<
      Array<{ securityDefiner: boolean; settings: string[] | null; definition: string }>
    >`
      SELECT
        procedure.prosecdef AS "securityDefiner",
        procedure.proconfig AS settings,
        pg_get_functiondef(procedure.oid) AS definition
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'opengeni_private'
        AND procedure.proname = 'claim_retained_screenshot_maintenance'`;
    expect(routine?.securityDefiner).toBe(true);
    expect(routine?.settings).toEqual(["search_path=pg_catalog"]);
    expect(routine?.definition).toContain(`${SCHEMA}.retained_screenshot_artifacts`);
    expect(routine?.definition).toContain(`${SCHEMA}.files`);
  });

  test("an existing dedicated 0140 lifecycle shape upgrades through 0180 and remains callable", async () => {
    if (!available) return;
    const databaseName = `og_0179_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
    const schemaName = "tenantupgrade";
    const controlUrl = new URL(ADMIN_URL);
    controlUrl.pathname = "/postgres";
    const control = postgres(controlUrl.toString(), { max: 1 });
    const upgradeUrl = new URL(ADMIN_URL);
    upgradeUrl.pathname = `/${databaseName}`;
    let upgradeAdmin: postgres.Sql | null = null;
    let upgradeClient: DbClient | null = null;
    try {
      await control.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      await migrate(upgradeUrl.toString(), schemaName);
      upgradeAdmin = postgres(upgradeUrl.toString(), { max: 1 });
      await upgradeAdmin.unsafe(`
        SET search_path = ${quoteIdentifier(schemaName)}, opengeni_private, public;
        DROP TRIGGER IF EXISTS retained_screenshot_detachment_queue_trg
          ON ${quoteIdentifier(schemaName)}.retained_screenshot_artifacts;
        DROP FUNCTION opengeni_private.claim_retained_screenshot_maintenance(bigint, bigint, integer);
        ALTER TABLE ${quoteIdentifier(schemaName)}.retained_screenshot_artifacts
          DROP CONSTRAINT retained_screenshot_artifacts_session_fk,
          DROP CONSTRAINT retained_screenshot_artifacts_turn_fk,
          DROP CONSTRAINT retained_screenshot_artifacts_attempt_fk,
          DROP CONSTRAINT retained_screenshot_artifacts_workspace_file_fk,
          DROP CONSTRAINT retained_screenshot_artifacts_status_chk,
          DROP CONSTRAINT retained_screenshot_artifacts_quota_state_chk,
          DROP CONSTRAINT retained_screenshot_artifacts_status_quota_chk,
          DROP CONSTRAINT retained_screenshot_artifacts_ready_shape_chk,
          DROP CONSTRAINT retained_screenshot_artifacts_cleanup_reason_chk,
          DROP CONSTRAINT retained_screenshot_artifacts_claim_shape_chk;
        ALTER TABLE ${quoteIdentifier(schemaName)}.retained_screenshot_artifacts
          ALTER COLUMN session_id SET NOT NULL,
          ALTER COLUMN turn_id SET NOT NULL,
          ALTER COLUMN attempt_id SET NOT NULL,
          DROP COLUMN quota_state,
          DROP COLUMN maintenance_claim_id,
          DROP COLUMN maintenance_claimed_at,
          ADD CONSTRAINT retained_screenshot_artifacts_workspace_session_fk
            FOREIGN KEY (workspace_id, session_id)
            REFERENCES ${quoteIdentifier(schemaName)}.sessions(workspace_id, id) ON DELETE CASCADE,
          ADD CONSTRAINT retained_screenshot_artifacts_workspace_turn_fk
            FOREIGN KEY (workspace_id, turn_id)
            REFERENCES ${quoteIdentifier(schemaName)}.session_turns(workspace_id, id) ON DELETE CASCADE,
          ADD CONSTRAINT retained_screenshot_artifacts_workspace_attempt_fk
            FOREIGN KEY (workspace_id, attempt_id)
            REFERENCES ${quoteIdentifier(schemaName)}.session_turn_attempts(workspace_id, id)
            ON DELETE RESTRICT,
          ADD CONSTRAINT retained_screenshot_artifacts_workspace_file_fk
            FOREIGN KEY (workspace_id, artifact_id)
            REFERENCES ${quoteIdentifier(schemaName)}.files(workspace_id, id) ON DELETE CASCADE,
          ADD CONSTRAINT retained_screenshot_artifacts_status_chk
            CHECK (status IN ('pending','reconciling','ready','cleanup_pending','failed','expired','deleted')),
          ADD CONSTRAINT retained_screenshot_artifacts_ready_shape_chk
            CHECK (
              (status = 'ready' AND ready_at IS NOT NULL)
              OR (status IN ('pending','reconciling') AND ready_at IS NULL)
              OR status IN ('cleanup_pending','failed','expired','deleted')
            ),
          ADD CONSTRAINT retained_screenshot_artifacts_terminal_cleanup_chk
            CHECK (status IN ('cleanup_pending','failed','expired','deleted') OR cleanup_reason IS NULL);
        CREATE FUNCTION opengeni_private.claim_retained_screenshot_maintenance(
          p_pending_grace_ms bigint,
          p_claim_timeout_ms bigint,
          p_limit integer
        )
        RETURNS TABLE (
          action text, artifact_id uuid, account_id uuid, workspace_id uuid,
          session_id uuid, object_key text, media_type text, size_bytes bigint,
          sha256 text, width integer, height integer,
          retention_expires_at timestamptz, cleanup_reason text
        )
        LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
        AS 'SELECT NULL::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
          NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::integer,
          NULL::integer, NULL::timestamptz, NULL::text WHERE false';
        DELETE FROM ${quoteIdentifier(schemaName)}.schema_migrations
          WHERE name = '0180_retained_screenshot_lifecycle_fences.sql';
      `);

      await migrate(upgradeUrl.toString(), schemaName);
      await provisionRoles(upgradeUrl.toString(), {
        targetSchema: schemaName,
        rlsStrategy: "force",
        appRole: "opengeni_app",
        appPassword: APP_PASSWORD,
      });
      const upgradeAppUrl = new URL(upgradeUrl);
      upgradeAppUrl.username = "opengeni_app";
      upgradeAppUrl.password = APP_PASSWORD;
      upgradeClient = createDb(upgradeAppUrl.toString(), {
        max: 1,
        searchPath: `${schemaName},opengeni_private,public`,
        rlsStrategy: "force",
      });
      await upgradeAdmin.unsafe(`
        REVOKE CREATE ON SCHEMA ${quoteIdentifier(schemaName)} FROM opengeni_app;
        REVOKE CREATE ON SCHEMA opengeni_private FROM opengeni_app;
        REVOKE CREATE ON SCHEMA public FROM opengeni_app;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      `);
      const fixture = await prepareClaimableScreenshot(upgradeClient.db, upgradeAdmin, schemaName);
      const claims = await claimRetainedScreenshotMaintenance(upgradeClient.db, {
        pendingGraceMs: 0,
        claimTimeoutMs: 60_000,
        limit: 10,
      });
      expect(claims.find((claim) => claim.artifactId === fixture.artifactId)).toMatchObject({
        action: "reconcile",
        workspaceId: fixture.workspaceId,
      });
      const [migration] = await upgradeAdmin<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM ${upgradeAdmin(schemaName)}.schema_migrations
        WHERE name = '0180_retained_screenshot_lifecycle_fences.sql'`;
      expect(migration?.count).toBe(1);
      expect(await readFile(lifecycleMigrationUrl, "utf8")).toContain(
        "FROM %1$I.retained_screenshot_artifacts",
      );
    } finally {
      await upgradeClient?.close();
      await upgradeAdmin?.end();
      await control.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
      await control.end();
    }
  }, 180_000);

  test("(A) tables + policies isolate to the dedicated schema, 0 in public", async () => {
    if (!available) return;
    const tablesInSchema = (
      await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = ${SCHEMA}`
    )[0]!.count;
    const tablesInPublic = (
      await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`
    )[0]!.count;
    const policiesInSchema = (
      await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_policies WHERE schemaname = ${SCHEMA}`
    )[0]!.count;
    const policiesInPublic = (
      await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_policies WHERE schemaname = 'public'`
    )[0]!.count;
    expect(tablesInSchema).toBeGreaterThan(30);
    expect(tablesInPublic).toBe(0);
    expect(policiesInSchema).toBeGreaterThan(20);
    expect(policiesInPublic).toBe(0);
  });

  test("(E) the createDb handle is bound to the force strategy", async () => {
    if (!available) return;
    expect(rlsStrategyFor(db)).toBe("force");
  });

  test("(B) rows written under A's RLS context land in the DEDICATED schema, not public", async () => {
    if (!available) return;
    const wsA = await freshWorkspace();
    const keyHash = `hashA-${crypto.randomUUID()}`;
    await createApiKey(db, {
      accountId: wsA.accountId,
      workspaceId: wsA.workspaceId,
      name: "keyA",
      prefix: "pkA",
      keyHash,
      permissions: ["workspace:read"],
    });
    // Superuser read of the DEDICATED schema's table — the row must be HERE.
    const inSchema = (
      await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ${admin(SCHEMA)}.api_keys WHERE key_hash = ${keyHash}`
    )[0]!.count;
    expect(inSchema).toBe(1);
    // And public.api_keys must NOT exist at all (proves no silent public fallback).
    const publicApiKeysExists = (
      await admin<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='api_keys') AS exists`
    )[0]!.exists;
    expect(publicApiKeysExists).toBe(false);
  });

  test("(C/D) cross-tenant read under B's context returns ZERO of A's rows; each tenant sees only its own", async () => {
    if (!available) return;
    const wsA = await freshWorkspace();
    const wsB = await freshWorkspace();
    const keyHashA = `iso-hash-A-${crypto.randomUUID()}`;
    const keyHashB = `iso-hash-B-${crypto.randomUUID()}`;
    await createApiKey(db, {
      accountId: wsA.accountId,
      workspaceId: wsA.workspaceId,
      name: "onlyA",
      prefix: "pA",
      keyHash: keyHashA,
      permissions: ["workspace:read"],
    });
    await createApiKey(db, {
      accountId: wsB.accountId,
      workspaceId: wsB.workspaceId,
      name: "onlyB",
      prefix: "pB",
      keyHash: keyHashB,
      permissions: ["workspace:read"],
    });

    // listApiKeys wraps withWorkspaceRls → sets the account/workspace GUCs for the
    // given workspace, then selects. Under FORCE RLS as opengeni_app, the policy
    // admits ONLY rows matching the GUC.
    const seenByA = await listApiKeys(db, wsA.workspaceId);
    const seenByB = await listApiKeys(db, wsB.workspaceId);
    expect(seenByA.map((k) => k.name).sort()).toEqual(["onlyA"]);
    expect(seenByB.map((k) => k.name).sort()).toEqual(["onlyB"]);

    // The decisive cross-tenant raw probe: under workspace B's RLS context, a
    // direct SELECT of A's hash returns ZERO rows. If RLS silently failed (wrong
    // schema, unforced, owner role), this would return A's row.
    const crossTenant = await withWorkspaceRls(db, wsB.workspaceId, async (scoped) => {
      const rows = await scoped.execute(
        // raw to bypass the helper's own workspace filter — pure RLS gate test.
        (await import("drizzle-orm")).sql`select id from api_keys where key_hash = ${keyHashA}`,
      );
      return rows as unknown as Array<{ id: string }>;
    });
    expect(crossTenant.length).toBe(0);

    // Sanity: under A's own context the same probe DOES find A's row (proves the
    // 0 above is RLS isolation, not a broken query / wrong schema returning empty).
    const ownTenant = await withWorkspaceRls(db, wsA.workspaceId, async (scoped) => {
      const rows = await scoped.execute(
        (await import("drizzle-orm")).sql`select id from api_keys where key_hash = ${keyHashA}`,
      );
      return rows as unknown as Array<{ id: string }>;
    });
    expect(ownTenant.length).toBe(1);
  });

  test("account/workspace GUCs are transaction-local and remain empty after reconnect", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    await withWorkspaceRls(db, workspace.workspaceId, async (scoped) => {
      const [inside] = (await scoped.execute(sql`
        select
          current_setting('opengeni.account_id', true) as account_id,
          current_setting('opengeni.workspace_id', true) as workspace_id
      `)) as unknown as Array<{ account_id: string; workspace_id: string }>;
      expect(inside).toEqual({
        account_id: workspace.accountId,
        workspace_id: workspace.workspaceId,
      });
    });

    const [afterCommit] = (await db.execute(sql`
      select
        current_setting('opengeni.account_id', true) as account_id,
        current_setting('opengeni.workspace_id', true) as workspace_id
    `)) as unknown as Array<{ account_id: string; workspace_id: string }>;
    expect(afterCommit).toEqual({ account_id: "", workspace_id: "" });

    const reconnected = createDb(APP_URL, {
      max: 1,
      searchPath: SEARCH_PATH,
      rlsStrategy: "force",
    });
    try {
      const [afterReconnect] = (await reconnected.db.execute(sql`
        select
          current_setting('opengeni.account_id', true) as account_id,
          current_setting('opengeni.workspace_id', true) as workspace_id
      `)) as unknown as Array<{ account_id: string | null; workspace_id: string | null }>;
      expect(afterReconnect?.account_id ?? "").toBe("");
      expect(afterReconnect?.workspace_id ?? "").toBe("");
    } finally {
      await reconnected.close();
    }
  });
});
