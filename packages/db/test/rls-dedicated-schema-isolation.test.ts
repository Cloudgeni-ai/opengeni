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
  ensureManagedAccessForUser,
  FORCE_RLS_TABLES,
  getOrCreateCompanyProfileSnapshot,
  getOrCreatePreferenceRegistrySnapshot,
  getOrCreateWorkspaceInstructionPolicySnapshot,
  initializeSessionStartAtomically,
  inspectCompanyBrainContextReceipts,
  listApiKeys,
  prepareRetainedScreenshotArtifact,
  PROTECTED_NO_DIRECT_DML_TABLES,
  RUNTIME_FULL_DML_TABLES,
  RUNTIME_TARGET_SCHEMA_FORBIDDEN_ROUTINES,
  RUNTIME_TARGET_SCHEMA_INVOKER_ROUTINES,
  RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES,
  rlsStrategyFor,
  resolveCompanyBrainContextSelection,
  setSubjectRlsContext,
  transitionSessionVisibility,
  upsertKnowledgeProvider,
  upsertKnowledgeSource,
  upsertKnowledgeSourceObject,
  withRlsContext,
  withSessionRlsActorContext,
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
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
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
let appRoleExistedBeforeMigration = true;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

// Seed a fresh (account, workspace) as the superuser (bypasses RLS) directly in
// the dedicated schema. We MUST schema-qualify because the admin connection's
// search_path is the server default (public).
async function freshWorkspace(): Promise<{
  accountId: string;
  workspaceId: string;
}> {
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
    reasoningEffort: "medium",
    latencyMode: "standard",
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

  const bootstrap = postgres(ADMIN_URL, { max: 1 });
  try {
    const [role] = await bootstrap<Array<{ exists: boolean }>>`
      SELECT exists(
        SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app'
      ) AS exists`;
    appRoleExistedBeforeMigration = role?.exists ?? true;
    if (appRoleExistedBeforeMigration) {
      throw new Error(
        "[rls-dedicated] clean-install proof requires opengeni_app to be absent before migration",
      );
    }
  } finally {
    await bootstrap.end();
  }

  // (A) embedded migrate into the dedicated schema via the SDK entry point.
  await migrate(ADMIN_URL, SCHEMA, { applicationDatabaseRoles: ["opengeni_app"] });
  await migrate(ADMIN_URL, SCHEMA, { applicationDatabaseRoles: ["opengeni_app"] });

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
  client = createDb(APP_URL, {
    max: 1,
    searchPath: SEARCH_PATH,
    rlsStrategy: "force",
  });
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
  test("0338 keeps activation evidence in the dedicated schema and owner-only", async () => {
    if (!available) return;
    const [routine] = await admin<
      Array<{
        securityDefiner: boolean;
        appExecute: boolean;
        publicExecute: boolean;
        settings: string[] | null;
        publicAbsent: boolean;
      }>
    >`
      select procedure.prosecdef as "securityDefiner",
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as "appExecute",
        exists (
          select 1 from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute",
        procedure.proconfig as settings,
        to_regprocedure('public.check_tenancy_backfill_activation_evidence(uuid)') is null
          as "publicAbsent"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = ${SCHEMA}
        and procedure.proname = 'check_tenancy_backfill_activation_evidence'`;
    expect(routine).toEqual({
      securityDefiner: true,
      appExecute: false,
      publicExecute: false,
      settings: [
        `search_path=pg_catalog, ${SCHEMA}, opengeni_private, pg_temp`,
        "statement_timeout=5min",
      ],
      publicAbsent: true,
    });
  });

  test("0338 pins connection convergence and activation to the dedicated schema", async () => {
    if (!available) return;
    const routines = await admin<
      Array<{ name: string; appExecute: boolean; settings: string[] | null }>
    >`
      select procedure.proname as name,
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as "appExecute",
        procedure.proconfig as settings
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = ${SCHEMA}
        and procedure.proname in (
          'classify_organization_connection_authority',
          'backfill_organization_connection_authority',
          'check_organization_tenancy_parity',
          'lock_session_tenancy_activation_boundary',
          'activate_session_tenancy_product'
        )
      order by procedure.proname`;
    expect(Array.from(routines)).toEqual([
      {
        name: "activate_session_tenancy_product",
        appExecute: false,
        settings: [`search_path=pg_catalog, ${SCHEMA}, opengeni_private, public, pg_temp`],
      },
      {
        name: "backfill_organization_connection_authority",
        appExecute: true,
        settings: [
          `search_path=pg_catalog, ${SCHEMA}, opengeni_private, pg_temp`,
          "statement_timeout=5min",
        ],
      },
      {
        name: "check_organization_tenancy_parity",
        appExecute: true,
        settings: [
          `search_path=pg_catalog, ${SCHEMA}, opengeni_private, pg_temp`,
          "statement_timeout=60s",
        ],
      },
      {
        name: "classify_organization_connection_authority",
        appExecute: true,
        settings: [
          `search_path=pg_catalog, ${SCHEMA}, opengeni_private, pg_temp`,
          "statement_timeout=5min",
        ],
      },
      {
        name: "lock_session_tenancy_activation_boundary",
        appExecute: false,
        settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
      },
    ]);
  });

  test("0323 pins every new definer routine to the dedicated schema", async () => {
    if (!available) return;
    const routines = await admin<
      Array<{
        name: string;
        securityDefiner: boolean;
        appExecute: boolean;
        publicExecute: boolean;
        settings: string[] | null;
      }>
    >`
      select
        procedure.proname as name,
        procedure.prosecdef as "securityDefiner",
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as "appExecute",
        exists (
          select 1
          from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute",
        procedure.proconfig as settings
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = ${SCHEMA}
        and procedure.proname in (
          'organization_private_sessions_enabled',
          'get_private_session_create_policy',
          'get_organization_private_session_settings',
          'update_organization_private_session_settings',
          'open_private_session_create_capability'
        )
      order by procedure.proname`;
    expect([...routines]).toEqual([
      {
        name: "get_organization_private_session_settings",
        securityDefiner: true,
        appExecute: true,
        publicExecute: false,
        settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
      },
      {
        name: "get_private_session_create_policy",
        securityDefiner: true,
        appExecute: true,
        publicExecute: false,
        settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
      },
      {
        name: "open_private_session_create_capability",
        securityDefiner: true,
        appExecute: true,
        publicExecute: false,
        settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
      },
      {
        name: "organization_private_sessions_enabled",
        securityDefiner: true,
        appExecute: false,
        publicExecute: false,
        settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
      },
      {
        name: "update_organization_private_session_settings",
        securityDefiner: true,
        appExecute: true,
        publicExecute: false,
        settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
      },
    ]);
  }, 180_000);

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
    expect(posture.targetRoutines).toEqual(
      [
        ...RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES.map((name) => ({
          name,
          owner: "postgres",
          execute: true,
          publicExecute: false,
          securityDefiner: !(RUNTIME_TARGET_SCHEMA_INVOKER_ROUTINES as readonly string[]).includes(
            name,
          ),
        })),
        ...RUNTIME_TARGET_SCHEMA_FORBIDDEN_ROUTINES.map((name) => ({
          name,
          owner: "postgres",
          execute: false,
          publicExecute: false,
          securityDefiner: true,
        })),
      ].sort((left, right) => left.name.localeCompare(right.name)),
    );
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
    ).toMatchObject({
      select: true,
      insert: false,
      update: false,
      delete: false,
    });
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
    ).toMatchObject({
      select: false,
      insert: false,
      update: false,
      delete: false,
    });

    const [preferenceFunctions] = await admin<
      Array<{
        lock_execute: boolean;
        lifecycle_execute: boolean;
        knowledge_proposal_execute: boolean;
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
        ) AS snapshot_execute,
        has_function_privilege(
          'opengeni_app',
          ${`${SCHEMA}.preference_registry_create_knowledge_proposal_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,uuid,text,text,text,text,integer,text,jsonb,timestamptz,text)`},
          'EXECUTE'
        ) AS knowledge_proposal_execute`;
    expect(preferenceFunctions).toEqual({
      knowledge_proposal_execute: true,
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

    const taskNoteFunctions = await admin<
      Array<{
        name: string;
        securityDefiner: boolean;
        appExecute: boolean;
        publicExecute: boolean;
        settings: string[] | null;
      }>
    >`
      SELECT
        procedure.proname AS name,
        procedure.prosecdef AS "securityDefiner",
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') AS "appExecute",
        exists (
          SELECT 1
          FROM aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
        ) AS "publicExecute",
        procedure.proconfig AS settings
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = ${SCHEMA}
        AND procedure.proname IN (
          'guard_task_note_mutation',
          'guard_task_note_event_mutation',
          'resolve_task_note_attempt_authority',
          'create_task_note_for_attempt',
          'archive_task_note_for_attempt',
          'list_task_notes_for_attempt'
        )
      ORDER BY procedure.proname`;
    expect(taskNoteFunctions).toHaveLength(6);
    const appExecutableTaskNoteFunctions = new Set([
      "archive_task_note_for_attempt",
      "create_task_note_for_attempt",
      "list_task_notes_for_attempt",
    ]);
    for (const routine of taskNoteFunctions) {
      expect(routine.securityDefiner).toBe(true);
      expect(routine.publicExecute).toBe(false);
      expect(routine.settings).toContain(`search_path=pg_catalog, ${SCHEMA}, pg_temp`);
      expect(routine.appExecute).toBe(appExecutableTaskNoteFunctions.has(routine.name));
    }
  });

  test("0305 grant routines keep exact dedicated-schema proconfig and lifecycle-only RLS", async () => {
    if (!available) return;
    const routines = await admin<Array<{ name: string; settings: string[] | null }>>`
      select procedure.proname as name, procedure.proconfig as settings
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = ${SCHEMA}
        and procedure.proname in (
          'list_self_user_resource_authorities',
          'issue_self_user_resource_grant',
          'revoke_self_user_resource_grant'
        )
        and pg_catalog.oidvectortypes(procedure.proargtypes) in (
          'uuid, uuid, text, uuid, integer',
          'uuid, uuid, uuid, text, text, text, uuid, integer, boolean',
          'uuid, uuid, uuid'
        )
      order by procedure.proname`;
    expect(Array.from(routines)).toEqual([
      {
        name: "issue_self_user_resource_grant",
        settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
      },
      {
        name: "list_self_user_resource_authorities",
        settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
      },
      {
        name: "revoke_self_user_resource_grant",
        settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
      },
    ]);
    const policies = await admin<Array<{ tableName: string; usingExpression: string }>>`
      select tablename as "tableName", qual as "usingExpression"
      from pg_policies
      where schemaname = ${SCHEMA}
        and policyname = 'organization_tenancy_lifecycle'
        and tablename in (
          'organization_memberships',
          'organization_user_resource_authorities',
          'organization_user_resource_grants'
        )
      order by tablename`;
    expect(policies).toHaveLength(3);
    for (const policy of policies) {
      expect(policy.usingExpression).toContain("personal_resource_grant_management");
    }
  });

  test("0336 fork overloads pin the dedicated schema ahead of caller TEMP shadows", async () => {
    if (!available) return;
    const routines = await admin<
      Array<{
        arguments: string;
        securityDefiner: boolean;
        appExecute: boolean;
        publicExecute: boolean;
        settings: string[] | null;
      }>
    >`
      select pg_catalog.oidvectortypes(procedure.proargtypes) as arguments,
        procedure.prosecdef as "securityDefiner",
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as "appExecute",
        exists (
          select 1
          from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute",
        procedure.proconfig as settings
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = ${SCHEMA}
        and procedure.proname = 'fork_session_content'
        and procedure.pronargs in (9, 10)
      order by procedure.pronargs`;
    expect(Array.from(routines)).toEqual([
      {
        arguments: "uuid, uuid, uuid, text, uuid, text, text, text, integer",
        securityDefiner: true,
        appExecute: true,
        publicExecute: false,
        settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
      },
      {
        arguments: "uuid, uuid, uuid, text, uuid, text, boolean, text, text, integer",
        securityDefiner: true,
        appExecute: true,
        publicExecute: false,
        settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
      },
    ]);
    const [receiptReplay] = await admin<
      Array<{
        securityDefiner: boolean;
        appExecute: boolean;
        publicExecute: boolean;
        settings: string[] | null;
      }>
    >`
      select procedure.prosecdef as "securityDefiner",
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as "appExecute",
        exists (
          select 1
          from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute",
        procedure.proconfig as settings
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = ${SCHEMA}
        and procedure.proname = 'replay_applied_session_fork'
        and pg_catalog.oidvectortypes(procedure.proargtypes)
          = 'uuid, uuid, uuid, text, uuid, text, boolean, text, text, integer'`;
    expect(receiptReplay).toEqual({
      securityDefiner: true,
      appExecute: true,
      publicExecute: false,
      settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
    });
    const [quiescenceHelper] = await admin<
      Array<{
        securityDefiner: boolean;
        appExecute: boolean;
        publicExecute: boolean;
        settings: string[] | null;
      }>
    >`
      select procedure.prosecdef as "securityDefiner",
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as "appExecute",
        exists (
          select 1
          from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute",
        procedure.proconfig as settings
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = ${SCHEMA}
        and procedure.proname = 'assert_session_tenancy_quiescent'
        and pg_catalog.oidvectortypes(procedure.proargtypes) = 'uuid, uuid, uuid, boolean'`;
    expect(quiescenceHelper).toEqual({
      securityDefiner: true,
      appExecute: false,
      publicExecute: false,
      settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
    });

    const suffix = crypto.randomUUID();
    const userId = `fork-shadow-${suffix}`;
    const subjectId = `user:${userId}`;
    const access = await ensureManagedAccessForUser(db, {
      userId,
      email: `${userId}@example.test`,
      name: "Fork shadow owner",
    });
    const grant = access.workspaceGrants[0]!;
    await admin`
      insert into ${admin(SCHEMA)}.session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (${grant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')
      on conflict (account_id) do nothing`;
    // A private fork destination in a shared workspace carries the same
    // organization owner/admin product decision as a private create; this
    // organization has enabled it, so the test exercises schema pinning rather
    // than the product gate.
    await admin`
      insert into ${admin(SCHEMA)}.organization_private_session_settings (
        account_id, enabled, version, updated_by_membership_id
      ) values (${grant.accountId}, true, 1, null)
      on conflict (account_id) do update set enabled = true`;
    const source = await withSessionRlsActorContext({ subjectId }, async () =>
      createSession(db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        initialMessage: "TEMP-shadow-resistant fork source",
        resources: [],
        metadata: {},
        model: "dedicated-schema-test",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId },
        createdByContext: {},
      }),
    );

    const app = postgres(APP_URL, { max: 1, prepare: false });
    try {
      const runShadowedFork = (kind: "atomic" | "legacy" | "replay") =>
        app.begin(async (transactionSql) => {
          await transactionSql`select set_config('search_path', ${SEARCH_PATH}, true)`;
          await transactionSql`select
            set_config('opengeni.account_id', ${grant.accountId}, true),
            set_config('opengeni.workspace_id', ${grant.workspaceId}, true),
            set_config('opengeni.subject_id', ${subjectId}, true)`;
          await transactionSql`create temporary table workspaces (
            shadow_marker boolean
          ) on commit drop`;
          await transactionSql`create temporary table organization_memberships (
            shadow_marker boolean
          ) on commit drop`;
          await transactionSql`create temporary table sessions (
            shadow_marker boolean
          ) on commit drop`;
          await transactionSql`create temporary table session_command_receipts (
            shadow_marker boolean
          ) on commit drop`;

          if (kind === "atomic") {
            const [atomic] = await transactionSql<Array<{ sessionId: string; visibility: string }>>`
              select session_id as "sessionId", visibility
              from fork_session_content(
                ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${source.id}::uuid,
                ${subjectId}, ${grant.workspaceId}::uuid, 'user_private', false,
                ${`atomic-shadow:${suffix}`}, ${"a".repeat(64)}, 1
              )`;
            return atomic;
          }
          if (kind === "replay") {
            const [replay] = await transactionSql<Array<{ sessionId: string; visibility: string }>>`
              select session_id as "sessionId", visibility
              from replay_applied_session_fork(
                ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${source.id}::uuid,
                ${subjectId}, ${grant.workspaceId}::uuid, 'user_private', false,
                ${`atomic-shadow:${suffix}`}, ${"a".repeat(64)}, 1
              )`;
            return replay;
          }
          const [legacy] = await transactionSql<Array<{ sessionId: string; visibility: string }>>`
            select session_id as "sessionId", visibility
            from fork_session_content(
              ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${source.id}::uuid,
              ${subjectId}, ${grant.workspaceId}::uuid, 'user_private',
              ${`legacy-shadow:${suffix}`}, ${"b".repeat(64)}, 1
            )`;
          return legacy;
        });
      const forked = {
        atomic: await runShadowedFork("atomic"),
        replay: await runShadowedFork("replay"),
        legacy: await runShadowedFork("legacy"),
      };
      expect(forked.atomic).toMatchObject({ visibility: "user_private" });
      expect(forked.replay).toEqual(forked.atomic);
      expect(forked.legacy).toMatchObject({ visibility: "user_private" });
      expect(forked.atomic?.sessionId).not.toBe(source.id);
      expect(forked.legacy?.sessionId).not.toBe(source.id);
      expect(forked.atomic?.sessionId).not.toBe(forked.legacy?.sessionId);
    } finally {
      await app.end();
    }
  }, 180_000);

  test("migrate-then-provision grants the exact target-schema knowledge authority lock", async () => {
    if (!available) return;
    expect(appRoleExistedBeforeMigration).toBe(false);

    const [routine] = await admin<
      Array<{
        arguments: string;
        securityDefiner: boolean;
        appExecute: boolean;
        publicExecute: boolean;
        settings: string[] | null;
      }>
    >`
      SELECT
        pg_catalog.oidvectortypes(procedure.proargtypes) AS arguments,
        procedure.prosecdef AS "securityDefiner",
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') AS "appExecute",
        exists (
          SELECT 1
          FROM aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
        ) AS "publicExecute",
        procedure.proconfig AS settings
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = ${SCHEMA}
        AND procedure.proname = 'knowledge_source_sync_lock_authority'`;
    expect(routine).toEqual({
      arguments: "uuid, uuid, uuid",
      securityDefiner: true,
      appExecute: true,
      publicExecute: false,
      settings: [`search_path=${SCHEMA}, pg_catalog`],
    });

    const workspace = await freshWorkspace();
    const subjectId = `knowledge-lock-${crypto.randomUUID()}`;
    const actor = {
      kind: "human" as const,
      subjectId,
      initiatingHumanSubjectId: subjectId,
    };
    const scope = {
      kind: "workspace" as const,
      workspaceId: workspace.workspaceId,
      subjectId: null,
    };
    const provider = await upsertKnowledgeProvider(db, {
      ...workspace,
      scope,
      operationId: `provider-${crypto.randomUUID()}`,
      actor,
      providerKey: "google-drive",
      externalTenantId: `tenant-${crypto.randomUUID()}`,
    });
    const source = await upsertKnowledgeSource(db, {
      ...workspace,
      scope,
      operationId: `source-${crypto.randomUUID()}`,
      actor,
      providerId: provider.id,
      externalSourceId: `source-${crypto.randomUUID()}`,
      sourceKind: "google-drive",
    });
    const object = await upsertKnowledgeSourceObject(db, {
      ...workspace,
      operationId: `object-${crypto.randomUUID()}`,
      actor,
      sourceId: source.id,
      externalObjectId: `object-${crypto.randomUUID()}`,
    });

    await withRlsContext(db, workspace, async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, subjectId);
      await scopedDb.execute(sql`
        SELECT knowledge_source_sync_lock_authority(
          ${workspace.accountId}::uuid,
          ${source.id}::uuid,
          ${object.id}::uuid
        )
      `);
    });
  });

  test("migrate-then-provision grants only the Company Brain preference proposal capability", async () => {
    if (!available) return;
    expect(appRoleExistedBeforeMigration).toBe(false);

    const [routine] = await admin<
      Array<{
        arguments: string;
        securityDefiner: boolean;
        appExecute: boolean;
        publicExecute: boolean;
        settings: string[] | null;
      }>
    >`
      SELECT
        pg_catalog.oidvectortypes(procedure.proargtypes) AS arguments,
        procedure.prosecdef AS "securityDefiner",
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') AS "appExecute",
        exists (
          SELECT 1
          FROM aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
        ) AS "publicExecute",
        procedure.proconfig AS settings
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = ${SCHEMA}
        AND procedure.proname = 'preference_registry_create_knowledge_proposal_for_attempt'`;
    expect(routine).toEqual({
      arguments:
        "uuid, uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text, text, text, text, integer, text, jsonb, timestamp with time zone, text",
      securityDefiner: true,
      appExecute: true,
      publicExecute: false,
      settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
    });

    const [receiptTable] = await admin<
      Array<{
        rlsEnabled: boolean;
        rlsForced: boolean;
        select: boolean;
        insert: boolean;
        update: boolean;
        delete: boolean;
        sessionVisibility: boolean;
      }>
    >`
      SELECT
        relation.relrowsecurity AS "rlsEnabled",
        relation.relforcerowsecurity AS "rlsForced",
        has_table_privilege('opengeni_app', relation.oid, 'SELECT') AS select,
        has_table_privilege('opengeni_app', relation.oid, 'INSERT') AS insert,
        has_table_privilege('opengeni_app', relation.oid, 'UPDATE') AS update,
        has_table_privilege('opengeni_app', relation.oid, 'DELETE') AS delete,
        exists (
          SELECT 1
          FROM pg_policy policy
          WHERE policy.polrelid = relation.oid
            AND policy.polname = 'session_visibility_isolation'
            AND policy.polpermissive = false
        ) AS "sessionVisibility"
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ${SCHEMA}
        AND relation.relname = 'company_brain_preference_proposal_receipts'`;
    expect(receiptTable).toEqual({
      rlsEnabled: true,
      rlsForced: true,
      select: false,
      insert: false,
      update: false,
      delete: false,
      sessionVisibility: true,
    });
  });

  test("migrate-then-provision hardens the exact Task-note promotion capability", async () => {
    if (!available) return;
    expect(appRoleExistedBeforeMigration).toBe(false);

    const [routine] = await admin<
      Array<{
        arguments: string;
        securityDefiner: boolean;
        appExecute: boolean;
        publicExecute: boolean;
        settings: string[] | null;
      }>
    >`
      SELECT
        pg_catalog.oidvectortypes(procedure.proargtypes) AS arguments,
        procedure.prosecdef AS "securityDefiner",
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') AS "appExecute",
        exists (
          SELECT 1
          FROM aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
        ) AS "publicExecute",
        procedure.proconfig AS settings
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = ${SCHEMA}
        AND procedure.proname = 'resolve_task_note_knowledge_promotion_source'`;
    expect(routine).toEqual({
      arguments: "uuid, uuid, uuid, uuid, uuid, integer, uuid, integer, text, text, text",
      securityDefiner: true,
      appExecute: true,
      publicExecute: false,
      settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
    });

    const authorityClosure = await admin<
      Array<{
        name: string;
        arguments: string;
        securityDefiner: boolean;
        settings: string[] | null;
      }>
    >`
      SELECT
        procedure.proname AS name,
        pg_catalog.oidvectortypes(procedure.proargtypes) AS arguments,
        procedure.prosecdef AS "securityDefiner",
        procedure.proconfig AS settings
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = ${SCHEMA}
        AND procedure.proname IN (
          'guard_task_note_mutation',
          'guard_task_note_event_mutation',
          'resolve_task_note_attempt_authority',
          'create_task_note_for_attempt',
          'archive_task_note_for_attempt',
          'list_task_notes_for_attempt',
          'session_private_actor_visible',
          'session_reference_visible'
        )
      ORDER BY procedure.proname`;
    expect(Array.from(authorityClosure)).toEqual([
      {
        name: "archive_task_note_for_attempt",
        arguments: "uuid, uuid, uuid, uuid, uuid, integer, uuid, uuid, integer, text",
        securityDefiner: true,
        settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
      },
      {
        name: "create_task_note_for_attempt",
        arguments: "uuid, uuid, uuid, uuid, uuid, integer, uuid, text, text, integer",
        securityDefiner: true,
        settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
      },
      {
        name: "guard_task_note_event_mutation",
        arguments: "",
        securityDefiner: true,
        settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
      },
      {
        name: "guard_task_note_mutation",
        arguments: "",
        securityDefiner: true,
        settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
      },
      {
        name: "list_task_notes_for_attempt",
        arguments: "uuid, uuid, uuid, uuid, uuid, integer, boolean, integer",
        securityDefiner: true,
        settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
      },
      {
        name: "resolve_task_note_attempt_authority",
        arguments: "uuid, uuid, uuid, uuid, uuid, integer",
        securityDefiner: true,
        settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
      },
      {
        name: "session_private_actor_visible",
        arguments: "uuid, uuid, uuid, text",
        securityDefiner: true,
        settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
      },
      {
        name: "session_reference_visible",
        arguments: "uuid, uuid, uuid",
        securityDefiner: false,
        settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
      },
    ]);

    const [capabilityTable] = await admin<
      Array<{
        rlsEnabled: boolean;
        rlsForced: boolean;
        select: boolean;
        insert: boolean;
        update: boolean;
        delete: boolean;
      }>
    >`
      SELECT
        relation.relrowsecurity AS "rlsEnabled",
        relation.relforcerowsecurity AS "rlsForced",
        has_table_privilege('opengeni_app', relation.oid, 'SELECT') AS select,
        has_table_privilege('opengeni_app', relation.oid, 'INSERT') AS insert,
        has_table_privilege('opengeni_app', relation.oid, 'UPDATE') AS update,
        has_table_privilege('opengeni_app', relation.oid, 'DELETE') AS delete
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ${SCHEMA}
        AND relation.relname = 'task_note_knowledge_promotion_capabilities'`;
    expect(capabilityTable).toEqual({
      rlsEnabled: true,
      rlsForced: true,
      select: false,
      insert: false,
      update: false,
      delete: false,
    });

    const [replacementRoutine] = await admin<
      Array<{
        arguments: string;
        securityDefiner: boolean;
        appExecute: boolean;
        publicExecute: boolean;
        settings: string[] | null;
      }>
    >`
      SELECT
        pg_catalog.oidvectortypes(procedure.proargtypes) AS arguments,
        procedure.prosecdef AS "securityDefiner",
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') AS "appExecute",
        exists (
          SELECT 1 FROM aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
        ) AS "publicExecute",
        procedure.proconfig AS settings
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = ${SCHEMA}
        AND procedure.proname = 'replace_task_note_for_attempt'`;
    expect(replacementRoutine).toEqual({
      arguments:
        "uuid, uuid, uuid, uuid, uuid, integer, uuid, uuid, uuid, uuid, integer, text, text, integer, text",
      securityDefiner: true,
      appExecute: true,
      publicExecute: false,
      settings: [`search_path=pg_catalog, ${SCHEMA}, pg_temp`],
    });

    const [replacementReceiptTable] = await admin<
      Array<{
        rlsEnabled: boolean;
        rlsForced: boolean;
        select: boolean;
        insert: boolean;
        update: boolean;
        delete: boolean;
      }>
    >`
      SELECT
        relation.relrowsecurity AS "rlsEnabled",
        relation.relforcerowsecurity AS "rlsForced",
        has_table_privilege('opengeni_app', relation.oid, 'SELECT') AS select,
        has_table_privilege('opengeni_app', relation.oid, 'INSERT') AS insert,
        has_table_privilege('opengeni_app', relation.oid, 'UPDATE') AS update,
        has_table_privilege('opengeni_app', relation.oid, 'DELETE') AS delete
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ${SCHEMA}
        AND relation.relname = 'task_note_replacement_receipts'`;
    expect(replacementReceiptTable).toEqual({
      rlsEnabled: true,
      rlsForced: true,
      select: false,
      insert: false,
      update: false,
      delete: false,
    });
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
      Array<{
        targetCreate: boolean;
        privateCreate: boolean;
        publicCreate: boolean;
      }>
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
      Array<{
        securityDefiner: boolean;
        settings: string[] | null;
        definition: string;
      }>
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
      await migrate(upgradeUrl.toString(), schemaName, {
        applicationDatabaseRoles: ["opengeni_app"],
      });
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

      await migrate(upgradeUrl.toString(), schemaName, {
        applicationDatabaseRoles: ["opengeni_app"],
      });
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

  test("0266 inspection remains content-free and TEMP-shadow-safe in the dedicated schema", async () => {
    if (!available) return;
    const suffix = crypto.randomUUID();
    const userId = `dedicated-context-${suffix}`;
    const subjectId = `user:${userId}`;
    const access = await ensureManagedAccessForUser(db, {
      userId,
      email: `${userId}@example.test`,
      name: "Dedicated context owner",
    });
    const grant = access.workspaceGrants[0]!;
    await admin`
      insert into ${admin(SCHEMA)}.session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (${grant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')
      on conflict (account_id) do nothing`;
    const session = await withSessionRlsActorContext({ subjectId }, async () =>
      createSession(db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        initialMessage: "inspect accepted context",
        resources: [],
        metadata: {},
        model: "dedicated-schema-test",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId },
        createdByContext: {},
      }),
    );
    await transitionSessionVisibility(db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      actorSubjectId: subjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `dedicated-context-private-${suffix}`,
    });
    await initializeSessionStartAtomically(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(db, grant.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `company-brain-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`fixture claim failed: ${claimed.reason}`);
    const claims = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
    };
    await withSessionRlsActorContext(
      { subjectId: "worker:dedicated-context", initiatingHumanSubjectId: subjectId },
      async () => {
        await getOrCreateCompanyProfileSnapshot(db, claims);
        await getOrCreateWorkspaceInstructionPolicySnapshot(db, claims);
        await getOrCreatePreferenceRegistrySnapshot(db, claims);
        await resolveCompanyBrainContextSelection(db, claims);
      },
    );

    const expected = await inspectCompanyBrainContextReceipts(db, {
      workspaceId: grant.workspaceId,
      subjectId,
      attemptId,
    });
    expect(expected).toHaveLength(1);
    expect(JSON.stringify(expected)).not.toContain("memorySelections");
    expect(JSON.stringify(expected)).not.toContain("legacyWorkspaceInstructions");

    const app = postgres(APP_URL, { max: 1, prepare: false });
    try {
      const shadowResistant = await app.begin(async (transactionSql) => {
        await transactionSql`select set_config('search_path', ${SEARCH_PATH}, true)`;
        await transactionSql`select
          set_config('opengeni.account_id', ${grant.accountId}, true),
          set_config('opengeni.workspace_id', ${grant.workspaceId}, true),
          set_config('opengeni.subject_id', ${subjectId}, true)`;
        await transactionSql`create temporary table company_brain_context_selection_receipts (
          id uuid, account_id uuid, workspace_id uuid, session_id uuid,
          root_session_id uuid, turn_id uuid
        )`;
        await transactionSql`create temporary table session_turns (
          id uuid, account_id uuid, workspace_id uuid, session_id uuid
        )`;
        await transactionSql`create temporary table session_turn_attempts (
          id uuid, account_id uuid, workspace_id uuid, session_id uuid, turn_id uuid
        )`;
        return await transactionSql<Array<{ receiptId: string }>>`
          select receipt_id as "receiptId"
          from company_brain_inspect_context_receipts(
            ${grant.accountId}::uuid, ${grant.workspaceId}::uuid,
            ${subjectId}::text, ${attemptId}::uuid, null, null, 1
          )
        `;
      });
      expect(shadowResistant.map((row) => row.receiptId)).toEqual(expected.map((row) => row.id));

      const crossSubject = await app.begin(async (transactionSql) => {
        const otherSubject = `user:other-${crypto.randomUUID()}`;
        await transactionSql`select set_config('search_path', ${SEARCH_PATH}, true)`;
        await transactionSql`select
          set_config('opengeni.account_id', ${grant.accountId}, true),
          set_config('opengeni.workspace_id', ${grant.workspaceId}, true),
          set_config('opengeni.subject_id', ${otherSubject}, true)`;
        return await transactionSql`select * from company_brain_inspect_context_receipts(
          ${grant.accountId}::uuid, ${grant.workspaceId}::uuid,
          ${otherSubject}::text, ${attemptId}::uuid, null, null, 1
        )`;
      });
      expect([...crossSubject]).toEqual([]);
    } finally {
      await app.end();
    }
  }, 180_000);

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
      `)) as unknown as Array<{
        account_id: string | null;
        workspace_id: string | null;
      }>;
      expect(afterReconnect?.account_id ?? "").toBe("");
      expect(afterReconnect?.workspace_id ?? "").toBe("");
    } finally {
      await reconnected.close();
    }
  });
});
