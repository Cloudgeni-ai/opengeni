import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  getSettings,
  withClaudeConnectionCatalog,
  resolveTurnExecutionPolicyV1,
  emptyClaudeUsage,
} from "@opengeni/config";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { encryptEnvironmentValue, decryptEnvironmentValue } from "../src/environment-crypto";

const migration = "0598_claude_subscription_account_pools.sql";
const key = Buffer.alloc(32, 67);
const ids = {
  account: randomUUID(),
  workspace: randomUUID(),
  workspaceCredential: randomUUID(),
  organizationCredential: randomUUID(),
};
const bundle = {
  version: 1,
  token: "sk-ant-oat01-synthetic-migration-token",
  identity: { accountUuid: randomUUID(), deviceId: "b".repeat(64) },
  oauth: {
    refreshToken: "synthetic-refresh-token",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    scopes: ["user:inference", "user:profile"],
  },
};
const work = {
  session: randomUUID(),
  child: randomUUID(),
  turn: randomUUID(),
  task: randomUUID(),
  run: randomUUID(),
  historicalRun: randomUUID(),
  outbox: randomUUID(),
};
let previousTaskDigest: string;
const model = "organization-claude-subscription/claude-fixture";
const metadata = {
  turnExecutionPolicyV1: resolveTurnExecutionPolicyV1(
    withClaudeConnectionCatalog(
      getSettings({ OPENGENI_ENV: "test", OPENGENI_CLAUDE_SUBSCRIPTION_ENABLED: "true" }),
      { claude_subscription: { active: true, models: [{ upstreamModelId: "claude-fixture" }] } },
      "organization",
    ),
    {
      modelId: model,
      requestedModelId: model,
      modelSource: "explicit",
      reasoningEffort: "high",
      reasoningSource: "explicit",
    },
  ),
};
let owned: OwnerMigratedTestDatabase;
let owner: postgres.Sql;
beforeAll(async () => {
  const fixture = await acquireOwnerMigratedTestDatabase("claude-pool-cutover");
  if (!fixture) throw new Error("Real PostgreSQL required");
  owned = fixture;
  owner = postgres(owned.ownerUrl, { max: 1 });
  await owner`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  await owner`INSERT INTO schema_migrations(name) VALUES(${migration})`;
  await migrate(owned.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
  await owner`DELETE FROM schema_migrations WHERE name = ${migration}`;
  await owned.admin`INSERT INTO managed_accounts(id, name) VALUES(${ids.account}, 'Subscription migration fixture')`;
  await owned.admin`INSERT INTO workspaces(id, account_id, name) VALUES(${ids.workspace}, ${ids.account}, 'Migration fixture')`;
  await owned.admin`INSERT INTO workspace_inference_controls(workspace_id, account_id) VALUES(${ids.workspace}, ${ids.account})`;
  await owned.admin`INSERT INTO connections
    (id, account_id, workspace_id, provider_domain, kind, credential_encrypted, version, metadata, allowed_model_ids, access_policy_version)
    VALUES (${ids.workspaceCredential}, ${ids.account}, ${ids.workspace}, 'api.anthropic.com', 'api_key',
      ${encryptEnvironmentValue(key, JSON.stringify({ apiKey: JSON.stringify(bundle) }))}, 3,
      '{"credentialRole":"claude_subscription"}'::jsonb, ARRAY['workspace-claude-subscription/claude-fixture'], 4)`;
  await owned.admin`UPDATE connections SET claude_usage_snapshot = ${owned.admin.json({ ...emptyClaudeUsage(3), connected: true })} WHERE id = ${ids.workspaceCredential}`;
  await owned.admin`INSERT INTO organization_model_provider_connections
    (id, account_id, provider_kind, credential_encrypted, version, operation_id, request_hash, updated_by_subject_id,
      allowed_workspace_ids, allow_personal_workspaces, access_policy_version)
    VALUES (${ids.organizationCredential}, ${ids.account}, 'claude_subscription',
      ${encryptEnvironmentValue(key, JSON.stringify(bundle))}, 2, ${randomUUID()}, ${"a".repeat(64)}, 'user:fixture',
      ARRAY[${ids.workspace}]::uuid[], false, 5)`;
  // Seed historical rows directly: this is an upgrade fixture, not current admission.
  for (const table of [
    "sessions",
    "session_turns",
    "scheduled_tasks",
    "scheduled_task_runs",
    "session_system_update_outbox",
  ])
    await owned.admin.unsafe(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
  await owned.admin`INSERT INTO sessions(id, account_id, workspace_id, initial_message, model, reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, root_session_id, nested_agent_depth, effective_max_nested_agent_depth, nested_agent_depth_policy_source, tool_policy, metadata)
    VALUES (${work.session}, ${ids.account}, ${ids.workspace}, 'Synthetic retained work', ${model}, 'high', 'standard', 'none', ${work.session}, ${work.session}, 0, 8, 'deployment', '{"mode":"explicit","inheritedFromSessionId":null}'::jsonb, ${owned.admin.json(metadata)})`;
  await owned.admin`INSERT INTO session_turns(id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id, status, source, position, prompt, model, reasoning_effort, latency_mode, sandbox_backend, metadata)
    VALUES (${work.turn}, ${ids.account}, ${ids.workspace}, ${work.session}, ${randomUUID()}, 'synthetic-workflow', 'queued', 'user', 1, 'Retained prompt', ${model}, 'high', 'standard', 'none', ${owned.admin.json(metadata)})`;
  await owned.admin`INSERT INTO sessions(id, account_id, workspace_id, initial_message, model, reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, root_session_id, nested_agent_depth, effective_max_nested_agent_depth, nested_agent_depth_policy_source, tool_policy, parent_session_id, parent_turn_id)
    VALUES (${work.child}, ${ids.account}, ${ids.workspace}, 'Synthetic child', 'workspace-claude-subscription/claude-fixture', 'high', 'standard', 'none', ${work.child}, ${work.session}, 1, 8, 'deployment', '{"mode":"explicit","inheritedFromSessionId":null}'::jsonb, ${work.session}, ${work.turn})`;
  await owned.admin`INSERT INTO scheduled_tasks(id, account_id, workspace_id, name, schedule, temporal_schedule_id, execution_digest, agent_config, metadata)
    VALUES (${work.task}, ${ids.account}, ${ids.workspace}, 'Synthetic task', '{}'::jsonb, 'synthetic-task', ${"0".repeat(64)}, ${owned.admin.json({ model })}, ${owned.admin.json(metadata)})`;
  await owned.admin`UPDATE scheduled_tasks SET execution_digest = scheduled_task_execution_digest(scheduled_tasks) WHERE id = ${work.task}`;
  const [task] =
    await owned.admin`SELECT execution_digest FROM scheduled_tasks WHERE id = ${work.task}`;
  previousTaskDigest = task!.execution_digest;
  for (const [id, revision, digest] of [
    [work.run, 1, previousTaskDigest],
    [work.historicalRun, 2, "f".repeat(64)],
  ] as const) {
    const snapshot = {
      task: { executionDigest: digest },
      resolvedModel: model,
      turnExecutionPolicy: metadata.turnExecutionPolicyV1,
    };
    await owned.admin`INSERT INTO scheduled_task_runs(id, account_id, workspace_id, task_id, task_authority_revision, task_execution_digest, status, trigger_type, accepted_execution_snapshot, accepted_execution_digest)
      VALUES (${id}, ${ids.account}, ${ids.workspace}, ${work.task}, ${revision}, ${digest}, 'completed', 'manual', ${owned.admin.json(snapshot)}, encode(digest(convert_to(${owned.admin.json(snapshot)}::jsonb::text, 'UTF8'), 'sha256'), 'hex'))`;
  }
  await owned.admin`INSERT INTO session_system_update_outbox(id, account_id, workspace_id, source_session_id, target_session_id, dedupe_key, kind, classification, source_id, summary, payload)
    VALUES (${work.outbox}, ${ids.account}, ${ids.workspace}, ${work.child}, ${work.session}, 'synthetic-child-result', 'child_terminal_result', 'result', 'synthetic-source', 'Synthetic result', '{"type":"child_terminal_result"}'::jsonb)`;
  for (const table of [
    "sessions",
    "session_turns",
    "scheduled_tasks",
    "scheduled_task_runs",
    "session_system_update_outbox",
  ])
    await owned.admin.unsafe(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
}, 180_000);
afterAll(async () => {
  await owner?.end();
  await owned?.release();
}, 60_000);

async function noPartialConversion() {
  const [objects] =
    await owned.admin`SELECT to_regclass('claude_subscription_credentials') AS credentials,
    to_regprocedure('opengeni_private.claude_subscription_pool_protocol_v1_active()') AS receipt`;
  expect(objects!.credentials).toBeNull();
  expect(objects!.receipt).toBeNull();
  const [legacy] =
    await owned.admin`SELECT status, credential_encrypted <> '' AS retained FROM connections WHERE id = ${ids.workspaceCredential}`;
  expect(legacy).toMatchObject({ status: "active", retained: true });
  const [source] =
    await owned.admin`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'connections'::regclass`;
  expect(source!.relforcerowsecurity).toBe(true);
  const [role] =
    await owned.admin`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${owned.ownerRole}`;
  expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
}
test("missing key rolls back DDL, source changes, RLS and activation", async () => {
  await expect(
    migrate(owned.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] }),
  ).rejects.toThrow("requires the existing environments encryption key");
  await noPartialConversion();
}, 180_000);
test("wrong key cannot partially retire a legacy account", async () => {
  await expect(
    migrate(owned.ownerUrl, undefined, {
      applicationDatabaseRoles: ["opengeni_app"],
      environmentsEncryptionKey: Buffer.alloc(32, 68),
    }),
  ).rejects.toThrow("could not decode a legacy credential");
  await noPartialConversion();
}, 180_000);
test("maintenance refuses even an idle application connection", async () => {
  const url = new URL(owned.ownerUrl);
  url.username = "opengeni_app";
  url.password = owned.appPassword;
  const app = postgres(url.toString(), { max: 1 });
  try {
    await app`SELECT 1`;
    await expect(
      migrate(owned.ownerUrl, undefined, {
        applicationDatabaseRoles: ["opengeni_app"],
        environmentsEncryptionKey: key,
      }),
    ).rejects.toMatchObject({ code: "55000" });
  } finally {
    await app.end();
  }
  await noPartialConversion();
}, 180_000);
test("plain SQL cannot bypass credential conversion", async () => {
  const source = await readFile(
    new URL("../drizzle/0598_claude_subscription_account_pools.sql", import.meta.url),
    "utf8",
  );
  await expect(Promise.resolve(owner.unsafe(source))).rejects.toMatchObject({ code: "55000" });
  await noPartialConversion();
}, 180_000);
test("non-superuser owner preserves account identity, generations, tokens, access and usage", async () => {
  await migrate(owned.ownerUrl, undefined, {
    applicationDatabaseRoles: ["opengeni_app"],
    environmentsEncryptionKey: key,
  });
  const rows =
    await owned.admin`SELECT * FROM claude_subscription_credentials ORDER BY authority_scope`;
  expect(rows).toHaveLength(2);
  const workspace = rows.find((row) => row.authority_scope === "workspace")!;
  const organization = rows.find((row) => row.authority_scope === "organization")!;
  expect(workspace).toMatchObject({
    id: ids.workspaceCredential,
    workspace_id: ids.workspace,
    version: 3,
    access_policy_version: 4,
    allowed_model_ids: ["workspace-claude-subscription/claude-fixture"],
    provider_account_id: bundle.identity.accountUuid,
  });
  expect(organization).toMatchObject({
    id: ids.organizationCredential,
    workspace_id: null,
    version: 2,
    access_policy_version: 5,
    allowed_workspace_ids: [ids.workspace],
    allow_personal_workspaces: false,
  });
  for (const row of rows)
    expect(JSON.parse(decryptEnvironmentValue(key, row.credential_encrypted))).toEqual(bundle);
  const pointers =
    await owned.admin`SELECT authority_scope, active_credential_id, rotation_enabled FROM claude_rotation_settings ORDER BY authority_scope`;
  expect(pointers.map((row) => row.rotation_enabled)).toEqual([false, false]);
  expect(new Set(pointers.map((row) => row.active_credential_id))).toEqual(
    new Set([ids.workspaceCredential, ids.organizationCredential]),
  );
  const [usage] =
    await owned.admin`SELECT credential_version, snapshot FROM claude_subscription_account_usage WHERE credential_id = ${ids.workspaceCredential}`;
  expect(usage!.credential_version).toBe(3);
  expect(usage!.snapshot.connected).toBe(true);
  const tables = await owned.admin`SELECT relname, relforcerowsecurity, relrowsecurity FROM pg_class
    WHERE relname IN ('connections', 'organization_model_provider_connections', 'claude_subscription_credentials', 'claude_subscription_account_usage')`;
  expect(tables.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  const [triggers] = await owned.admin`SELECT count(*)::integer AS disabled FROM pg_trigger
    WHERE tgrelid IN ('connections'::regclass, 'claude_subscription_credentials'::regclass) AND NOT tgisinternal AND tgenabled = 'D'`;
  expect(triggers!.disabled).toBe(0);
  const old =
    await owned.admin`SELECT credential_encrypted, status FROM connections WHERE id = ${ids.workspaceCredential}`;
  expect(old[0]).toMatchObject({ credential_encrypted: "", status: "revoked" });
}, 180_000);
test("old writers cannot resurrect subscription credentials", async () => {
  await expect(
    Promise.resolve(
      owned.admin`UPDATE connections SET status = 'active', credential_encrypted = 'synthetic' WHERE id = ${ids.workspaceCredential}`,
    ),
  ).rejects.toMatchObject({ code: "0A000" });
  await expect(
    Promise.resolve(
      owned.admin`UPDATE organization_model_provider_connections SET status = 'active', credential_encrypted = 'synthetic' WHERE id = ${ids.organizationCredential}`,
    ),
  ).rejects.toMatchObject({ code: "0A000" });
});
test("the atomic migration ledger makes retry independent of the encryption key", async () => {
  await migrate(owned.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
  const [count] =
    await owned.admin`SELECT count(*)::integer AS total FROM claude_subscription_credentials`;
  expect(count!.total).toBe(2);
}, 180_000);

test("accepted turns, children, task digests and producer inputs retain their original organization scope", async () => {
  const sessions =
    await owned.admin`SELECT id, initial_claude_provider_account_authority_snapshot AS authority FROM sessions WHERE id IN (${work.session}, ${work.child})`;
  expect(sessions).toHaveLength(2);
  for (const row of sessions) expect(row.authority).toEqual({ version: 1, scope: "organization" });
  const [turn] =
    await owned.admin`SELECT claude_provider_account_authority_snapshot AS authority, prompt, metadata FROM session_turns WHERE id = ${work.turn}`;
  expect(turn).toMatchObject({
    authority: { version: 1, scope: "organization" },
    prompt: "Retained prompt",
    metadata,
  });
  const [task] =
    await owned.admin`SELECT execution_digest, claude_provider_account_authority_snapshot AS authority FROM scheduled_tasks WHERE id = ${work.task}`;
  expect(task!.execution_digest).not.toBe(previousTaskDigest);
  expect(task!.authority).toEqual({ version: 1, scope: "organization" });
  const runs =
    await owned.admin`SELECT id, task_execution_digest, accepted_execution_snapshot AS snapshot,
    accepted_execution_digest = encode(digest(convert_to(accepted_execution_snapshot::text, 'UTF8'), 'sha256'), 'hex') AS valid_digest FROM scheduled_task_runs WHERE task_id = ${work.task}`;
  for (const run of runs) {
    expect(run.valid_digest).toBe(true);
    expect(run.snapshot.claudeProviderAccountAuthoritySnapshot).toEqual({
      version: 1,
      scope: "organization",
    });
    expect(run.task_execution_digest).toBe(
      run.id === work.run ? task!.execution_digest : "f".repeat(64),
    );
    expect(run.snapshot.task.executionDigest).toBe(run.task_execution_digest);
  }
  const [outbox] =
    await owned.admin`SELECT claude_provider_account_authority_snapshot AS authority FROM session_system_update_outbox WHERE id = ${work.outbox}`;
  expect(outbox!.authority).toEqual({ version: 1, scope: "organization" });
  const relations =
    await owned.admin`SELECT relname, relforcerowsecurity FROM pg_class WHERE relkind = 'r' AND (relname LIKE 'scheduled_task%authorit%' OR relname = 'scheduled_task_run_personal_resource_admissions')`;
  expect(relations.every((row) => row.relforcerowsecurity)).toBe(true);
}, 180_000);

test("cloned capacity waiters retain the enabled xAI tenancy fence and reject unfenced app mutations before effect", async () => {
  const triggers = await owned.admin`SELECT relation.relname, trigger.tgenabled,
    trigger.tgfoid::regprocedure::text AS function,
    pg_get_triggerdef(trigger.oid) AS definition
    FROM pg_trigger trigger JOIN pg_class relation ON relation.oid = trigger.tgrelid
    WHERE trigger.tgrelid IN ('xai_capacity_waiters'::regclass, 'claude_capacity_waiters'::regclass)
      AND trigger.tgname = 'session_tenancy_workspace_fence' AND NOT trigger.tgisinternal
    ORDER BY relation.relname`;
  expect(triggers).toHaveLength(2);
  const claude = triggers.find((row) => row.relname === "claude_capacity_waiters")!;
  const xai = triggers.find((row) => row.relname === "xai_capacity_waiters")!;
  expect(xai.tgenabled).toBe("O");
  expect(claude.tgenabled).toBe(xai.tgenabled);
  expect(claude.function).toBe("opengeni_private.require_session_tenancy_fence()");
  expect(claude.function).toBe(xai.function);
  expect(claude.definition).toBe(xai.definition.replaceAll("xai_", "claude_"));
  const posture = await owned.admin`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
    WHERE oid IN ('xai_capacity_waiters'::regclass, 'claude_capacity_waiters'::regclass)`;
  expect(posture).toHaveLength(2);
  expect(posture.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);

  await provisionRoles(owned.adminUrl, { appRole: "opengeni_app", appPassword: owned.appPassword });
  const url = new URL(owned.adminUrl);
  url.username = "opengeni_app";
  url.password = owned.appPassword;
  const app = postgres(url.toString(), { max: 1 });
  const waiterId = randomUUID();
  try {
    const [role] =
      await app`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
    const insert = (tx: postgres.TransactionSql) => tx`INSERT INTO claude_capacity_waiters
      (id, account_id, workspace_id, session_id, blocked_turn_id, blocked_turn_generation,
        workflow_id, authority_scope, next_check_at)
      VALUES (${waiterId}, ${ids.account}, ${ids.workspace}, ${work.session}, ${work.turn}, 1,
        'synthetic-workflow', 'workspace', now())`;
    const scoped = async (
      mutation: (tx: postgres.TransactionSql) => Promise<unknown>,
      fenced = false,
    ) =>
      await app.begin(async (tx) => {
        await tx`SELECT set_config('opengeni.account_id', ${ids.account}, true),
          set_config('opengeni.workspace_id', ${ids.workspace}, true),
          set_config('opengeni.subject_id', 'user:fixture', true),
          set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
        if (fenced)
          await tx`SELECT pg_advisory_xact_lock_shared(hashtextextended('session-tenancy:' || ${ids.workspace}, 0))`;
        return await mutation(tx);
      });
    const fenceFailure = {
      code: "55000",
      message: "session tenancy mutation requires the workspace fence",
      detail: "claude_capacity_waiters",
    };
    await expect(scoped(insert)).rejects.toMatchObject(fenceFailure);
    expect(
      await owned.admin`SELECT id FROM claude_capacity_waiters WHERE id = ${waiterId}`,
    ).toHaveLength(0);
    // The same role, tenant, row and RLS policies succeed only with the fence.
    await scoped(insert, true);
    const before = await owned.admin`SELECT * FROM claude_capacity_waiters WHERE id = ${waiterId}`;
    expect(before).toHaveLength(1);
    await scoped(async (tx) => {
      expect(await tx`SELECT id FROM claude_capacity_waiters WHERE id = ${waiterId}`).toHaveLength(
        1,
      );
    });
    await expect(
      scoped(
        (tx) => tx`UPDATE claude_capacity_waiters SET wake_revision = wake_revision + 1
      WHERE id = ${waiterId}`,
      ),
    ).rejects.toMatchObject(fenceFailure);
    expect([
      ...(await owned.admin`SELECT * FROM claude_capacity_waiters WHERE id = ${waiterId}`),
    ]).toEqual([...before]);
    await expect(
      scoped((tx) => tx`DELETE FROM claude_capacity_waiters WHERE id = ${waiterId}`),
    ).rejects.toMatchObject(fenceFailure);
    expect([
      ...(await owned.admin`SELECT * FROM claude_capacity_waiters WHERE id = ${waiterId}`),
    ]).toEqual([...before]);
    await scoped((tx) => tx`DELETE FROM claude_capacity_waiters WHERE id = ${waiterId}`, true);
    expect(
      await owned.admin`SELECT id FROM claude_capacity_waiters WHERE id = ${waiterId}`,
    ).toHaveLength(0);
  } finally {
    await app.end();
  }
}, 180_000);
