import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  claimSessionWorkForAttempt,
} from "../src";
import { executeMigrationFile, migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const directory = new URL("../drizzle/", import.meta.url);
const additions = [
  "0618_tool_approval_defaults.sql",
  "0619_codemode_approval_continuation.sql",
  "0620_tool_action_review_details.sql",
  "0621_legacy_api_tool_preferences.sql",
];
let owned: OwnerMigratedTestDatabase;
let owner: postgres.Sql;
let appRole: string;
let appUrl: string;

beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("tool-approval-upgrade");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  owned = acquired;
  owner = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
  await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
  await owner`select set_config('opengeni.migration_application_roles', '["opengeni_app"]', false)`;
  // Execute the actual previous ledger, including codec-aware migration hooks.
  // No current-schema downgrade or fabricated replacement tables stand in for an upgrade.
  for (const file of (await readdir(directory))
    .filter((name) => name.endsWith(".sql") && name < additions[0]!)
    .sort()) {
    await executeMigrationFile(owner, file, await readFile(new URL(file, directory), "utf8"), {
      preinstalledVector: true,
    });
    await owner`insert into schema_migrations(name) values(${file}) on conflict do nothing`;
  }
  appRole = `approval_app_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionRoles(owned.adminUrl, { appRole, appPassword: owned.appPassword });
  const url = new URL(owned.adminUrl);
  url.username = appRole;
  url.password = owned.appPassword;
  appUrl = url.toString();
}, 300_000);

afterAll(async () => {
  await owner?.end({ timeout: 5 });
  if (owned && appRole) {
    await owned.admin.unsafe(`DROP OWNED BY "${appRole}"`);
    await owned.admin.unsafe(`DROP ROLE "${appRole}"`);
  }
  await owned?.release();
}, 180_000);

test("a populated previous ledger refuses live writers, rolls back failed activation and upgrades without replay", async () => {
  const client = createDb(owned.adminUrl);
  let liveApp: postgres.Sql | undefined;
  try {
    const grant = (
      await bootstrapWorkspace(client.db, {
        accountExternalSource: "test",
        accountExternalId: crypto.randomUUID(),
        accountName: "Upgrade fixture",
        workspaceExternalSource: "test",
        workspaceExternalId: crypto.randomUUID(),
        workspaceName: "Upgrade fixture",
        subjectId: "human:upgrade-fixture",
      })
    ).workspaceGrants[0]!;
    // Current session adapters select columns from later migrations. Supply
    // only those reader columns for the seed, and remove them before replay.
    await owner`alter table sessions
      add column keep_live boolean not null default false,
      add column content_archive_state text,
      add column content_archive_started_at timestamptz,
      add column content_archived_at timestamptz,
      add column content_archive jsonb,
      add column content_archive_purged_at timestamptz`;
    // The current turn adapter also selects the nullable M3 authority snapshot
    // while this fixture is intentionally stopped before that migration.
    await owner`alter table session_turns add column subscription_authority jsonb`;
    // ...and the M3 PR 3b slots on internal updates and their outbox rows.
    await owner`alter table session_system_updates add column subscription_authority jsonb`;
    await owner`alter table session_system_update_outbox add column subscription_authority jsonb`;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Synthetic upgrade",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error("Fixture claim failed");
    const scope = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
    };
    const catalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [
        {
          identity: { serverId: "fixture", toolName: "change" },
          modelName: "fixture__change",
          description: "Change a synthetic item",
          inputSchema: { type: "object" },
          source: "mcp",
          approval: "none",
          execute: async () => {
            throw new Error("Migration must never execute a provider");
          },
        },
      ],
    }).catalog;
    // The previous ledger stores catalogs inline (pre-0648 legacy form).
    await owned.admin`insert into session_attempt_tool_catalogs
      (attempt_id,account_id,workspace_id,session_id,turn_id,execution_generation,catalog_version,
       generation,digest,catalog,created_at)
      values(${attemptId},${scope.accountId},${scope.workspaceId},${scope.sessionId},${scope.turnId},
       ${scope.executionGeneration},${catalog.version},${catalog.generation},${catalog.digest},
       ${owned.admin.json(catalog as unknown as postgres.JSONValue)},${new Date(catalog.createdAt)})`;
    const requestId = crypto.randomUUID();
    await owned.admin`insert into connector_action_requests
      (id,account_id,workspace_id,session_id,turn_id,creation_attempt_id,creation_execution_generation,
       approval_id,initiator_kind,initiator_subject_id,connection_id,server_id,tool_name,action_name,
       policy_source,policy_decision,action_fingerprint,status)
      values(${requestId},${scope.accountId},${scope.workspaceId},${scope.sessionId},${scope.turnId},${attemptId},${scope.executionGeneration},
       'synthetic-review','subject',${grant.subjectId},'session-mcp:fixture:synthetic','fixture','change','*',
       'explicit','ask',${"a".repeat(64)},'pending')`;
    for (const state of ["queued", "running", "completed", "outcome_unknown"]) {
      const started = state !== "queued";
      const terminal = state === "completed" || state === "outcome_unknown";
      await owned.admin`insert into session_attempt_codemode_calls
        (operation_id,account_id,workspace_id,session_id,turn_id,attempt_id,execution_generation,catalog_digest,
         request_digest,server_id,tool_name,arguments,caller_subject_id,state,claim_id,claimed_at,execution_started_at,
         claim_expires_at,completed_at,result,error_code,error_message)
        values(${crypto.randomUUID()},${scope.accountId},${scope.workspaceId},${scope.sessionId},${scope.turnId},${attemptId},
         ${scope.executionGeneration},${catalog.digest},${"b".repeat(64)},'fixture','change',${owned.admin.json({ ids: ["synthetic-1"] })},
         ${grant.subjectId},${state},${started ? crypto.randomUUID() : null},${started ? new Date() : null},${started ? new Date() : null},
         ${started ? new Date(Date.now() + 60_000) : null},${terminal ? new Date() : null},${state === "completed" ? owned.admin.json({ accepted: true }) : null},
         ${state === "outcome_unknown" ? "transport_lost" : null},${state === "outcome_unknown" ? "Synthetic unknown result" : null})`;
    }
    const beforeRequests = [
      ...(await owned.admin`select to_jsonb(r) as row from connector_action_requests r order by id`),
    ];
    const beforeCalls = [
      ...(await owned.admin`select to_jsonb(c) as row from session_attempt_codemode_calls c order by operation_id`),
    ];
    const beforeLedger = [...(await owner`select * from schema_migrations order by name`)];
    const continuation = await readFile(new URL(additions[1]!, directory), "utf8");
    const preferences = await readFile(new URL(additions[3]!, directory), "utf8");
    // The restricted owner sees no tenant rows, but still sees live login identities.
    expect(await owner`select * from session_attempt_codemode_calls`).toHaveLength(0);
    for (const invalid of ["", "{}", "[]", '[" "]', '["same","same"]']) {
      await owner`select set_config('opengeni.migration_application_roles', ${invalid}, false)`;
      await expect(executeMigrationFile(owner, additions[1]!, continuation)).rejects.toThrow(
        "requires",
      );
      await expect(executeMigrationFile(owner, additions[3]!, preferences)).rejects.toThrow(
        "requires",
      );
    }
    await owner`select set_config('opengeni.migration_application_roles', ${JSON.stringify([appRole])}, false)`;
    liveApp = postgres(appUrl, { max: 1 });
    await liveApp`select 1`;
    for (const [file, sql] of [
      [additions[1]!, continuation],
      [additions[3]!, preferences],
    ]) {
      await expect(executeMigrationFile(owner, file!, sql!)).rejects.toThrow(
        "requires stopped application roles",
      );
    }
    expect([...(await owner`select * from schema_migrations order by name`)]).toEqual(beforeLedger);
    expect(
      await owner`select column_name from information_schema.columns where table_name='session_attempt_codemode_calls' and column_name='durable_approval'`,
    ).toHaveLength(0);
    await owner`alter table sessions
      drop column keep_live,
      drop column content_archive_state,
      drop column content_archive_started_at,
      drop column content_archived_at,
      drop column content_archive,
      drop column content_archive_purged_at`;
    await owner`alter table session_turns drop column subscription_authority`;
    await owner`alter table session_system_updates drop column subscription_authority`;
    await owner`alter table session_system_update_outbox drop column subscription_authority`;
    // The real runner commits one file at a time: the rolling default may
    // succeed, but activation must refuse a still-connected runtime login.
    await expect(
      migrate(owned.ownerUrl, undefined, {
        applicationDatabaseRoles: [appRole],
        preinstalledVector: true,
      }),
    ).rejects.toThrow("requires stopped application roles");
    expect(
      (await owner`select name from schema_migrations order by name`)
        .map((row) => row.name)
        .filter((name) => additions.includes(name)),
    ).toEqual([additions[0]!]);
    expect(
      await owner`select column_name from information_schema.columns where table_name='session_attempt_codemode_calls' and column_name='durable_approval'`,
    ).toHaveLength(0);
    await liveApp.end({ timeout: 5 });
    liveApp = undefined;
    // Abort after actual DDL: the whole migration must roll back before retry.
    await expect(
      owner.begin(async (tx) => {
        for (const file of additions) {
          await tx.unsafe(await readFile(new URL(file, directory), "utf8"));
        }
        throw new Error("injected activation failure");
      }),
    ).rejects.toThrow("injected activation failure");
    expect(
      await owner`select column_name from information_schema.columns where table_name='session_attempt_codemode_calls' and column_name='durable_approval'`,
    ).toHaveLength(0);
    await migrate(owned.ownerUrl, undefined, {
      applicationDatabaseRoles: [appRole],
      preinstalledVector: true,
    });
    const afterRequests = [
      ...(await owned.admin`select to_jsonb(r) - 'review_arguments' - 'review_context' as row from connector_action_requests r order by id`),
    ];
    const afterCalls = [
      ...(await owned.admin`select to_jsonb(c) - 'durable_approval' - 'approval_request_id' - 'effect_digest' - 'execution_attempt_id' - 'execution_attempt_generation' - 'execution_catalog_digest' as row from session_attempt_codemode_calls c order by operation_id`),
    ];
    expect(afterRequests).toEqual(beforeRequests);
    expect(afterCalls).toEqual(beforeCalls);
    expect(
      await owned.admin`select * from session_attempt_codemode_calls where durable_approval or approval_request_id is not null`,
    ).toHaveLength(0);
    expect(
      (await owned.admin`select status from connector_action_requests where id=${requestId}`)[0]!
        .status,
    ).toBe("pending");
    // New waiting state requires a bound request; old rows remain old-client safe.
    await expect(
      Promise.resolve(
        owned.admin`update session_attempt_codemode_calls set state='waiting_for_approval' where state='queued'`,
      ),
    ).rejects.toThrow();
    const applied = [...(await owner`select * from schema_migrations order by name`)];
    expect(applied.filter((row) => additions.includes(row.name))).toHaveLength(4);
    await migrate(owned.ownerUrl, undefined, {
      applicationDatabaseRoles: [appRole],
      preinstalledVector: true,
    });
    expect([...(await owner`select * from schema_migrations order by name`)]).toEqual(applied);
    expect(await owner`select * from session_attempt_codemode_calls`).toHaveLength(0);
    liveApp = postgres(appUrl, { max: 1 });
    expect(await liveApp`select * from session_attempt_codemode_calls`).toHaveLength(0);
    expect(await liveApp`select * from connector_action_requests`).toHaveLength(0);
    const posture =
      await owned.admin`select relforcerowsecurity from pg_class where relname in ('session_attempt_codemode_calls','connector_action_requests','connector_action_policies')`;
    expect(posture).toHaveLength(3);
    expect(posture.every((row) => row.relforcerowsecurity)).toBe(true);
  } finally {
    await liveApp?.end({ timeout: 5 });
    await client.close();
  }
}, 300_000);
