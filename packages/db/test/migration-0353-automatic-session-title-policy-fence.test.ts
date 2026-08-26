import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
} from "@opengeni/contracts";
import {
  acquireOwnerMigratedTestDatabase,
  acquireBlankTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { migrate, parseConcurrentIndexMigration } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  evaluateRuntimeDatabasePosture,
  FORCE_RLS_TABLES,
  inspectRuntimeDatabasePosture,
  PROTECTED_NO_DIRECT_DML_TABLES,
  RUNTIME_TARGET_SCHEMA_FORBIDDEN_ROUTINES,
} from "../src/runtime-posture";
import {
  addSessionSystemUpdateWithSourceMutation,
  appendSessionEvents,
  bindScheduledTaskRunSessionInTransaction,
  bootstrapWorkspace,
  claimAutomaticSessionTitleFanout,
  createDb,
  createScheduledTask,
  createScheduledTaskRun,
  createSession,
  getScheduledTargetSessionExecution,
  getScheduledTaskPersonalResourceAuthoritySubject,
  getScheduledTaskRevisionAuthority,
  getScheduledTaskRunAcceptedExecution,
  getSession,
  markAutomaticSessionTitleFanoutDelivered,
  settleScheduledTaskRunInTransaction,
  updateSessionTitle,
  type DbClient,
} from "../src/index";

const fenceMigrationUrl = new URL(
  "../drizzle/0353_automatic_session_title_policy_fence.sql",
  import.meta.url,
);
const quarantineIndexMigrationUrl = new URL(
  "../drizzle/0354_automatic_session_title_quarantine_index.sql",
  import.meta.url,
);
const quarantineMigrationUrl = new URL(
  "../drizzle/0355_automatic_session_title_quarantine.sql",
  import.meta.url,
);
const provisionRolesUrl = new URL("../src/provision-roles.ts", import.meta.url);
const migrationsDirectoryUrl = new URL("../drizzle/", import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("automatic-session-title-policy-fence");
  if (!shared) return;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function quarantineStatement(batchSize = 500): Promise<string> {
  const source = await readFile(quarantineMigrationUrl, "utf8");
  const statement = source
    .replaceAll("\r\n", "\n")
    .split("\n")
    .slice(2)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();
  return batchSize === 500
    ? statement
    : statement
        .replace("500::integer AS batch_size", `${batchSize}::integer AS batch_size`)
        .replace("LIMIT 500", `LIMIT ${batchSize}`);
}

async function runQuarantineBatch(
  database: SharedTestDatabase,
  statement: string,
  failAfterUpdate = false,
): Promise<Array<{ id: string }>> {
  return await database.admin.begin(async (transaction) => {
    await transaction`select
      set_config('lock_timeout', '1s', true),
      set_config('statement_timeout', '10s', true)`;
    const rows = await transaction.unsafe<Array<{ id: string }>>(statement);
    if (failAfterUpdate) throw new Error("forced title quarantine batch failure");
    return rows;
  });
}

async function drainQuarantine(
  database: SharedTestDatabase,
  statement: string,
  maxBatches = 16,
): Promise<number> {
  let quarantined = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await runQuarantineBatch(database, statement);
    quarantined += rows.length;
    if (rows.length === 0) return quarantined;
  }
  throw new Error(`title quarantine did not drain after ${maxBatches} bounded batches`);
}

async function addAcceptedScheduledOccurrence(input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
}) {
  const task = await createScheduledTask(client.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    name: "title rollout scheduled task",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `title-rollout-${crypto.randomUUID()}`,
    runMode: "existing_session",
    overlapPolicy: "allow_concurrent",
    agentConfig: {
      prompt: "Continue the rollout regression",
      resources: [],
      tools: [],
      metadata: {},
    },
    createdBy: { kind: "service", subjectId: "scheduler" },
    targetSessionId: input.sessionId,
    metadata: {},
  });
  const personalResourceAuthoritySubjectId = await getScheduledTaskPersonalResourceAuthoritySubject(
    client.db,
    {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      taskId: task.id,
      taskAuthorityRevision: task.authorityRevision,
    },
  );
  const targetSessionExecution = await getScheduledTargetSessionExecution(
    client.db,
    task.workspaceId,
    input.sessionId,
    personalResourceAuthoritySubjectId,
  );
  if (!targetSessionExecution) throw new Error("scheduled target execution is unavailable");
  const causalHumanAuthority = await getScheduledTaskRevisionAuthority(client.db, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    taskId: task.id,
    taskAuthorityRevision: task.authorityRevision,
  });
  const runId = crypto.randomUUID();
  const run = await createScheduledTaskRun(client.db, {
    runId,
    workspaceId: task.workspaceId,
    taskId: task.id,
    taskAuthorityRevision: task.authorityRevision,
    taskExecutionDigest: task.executionDigest,
    triggerType: "scheduled",
    producerKey: `title-rollout-run:${runId}`,
    acceptedExecutionSnapshot: {
      version: 1,
      task,
      resolvedModel: targetSessionExecution.model,
      resolvedReasoningEffort: targetSessionExecution.reasoningEffort,
      resolvedLatencyMode: targetSessionExecution.latencyMode,
      resolvedSandboxBackend: targetSessionExecution.sandboxBackend,
      resolvedSandboxOs: targetSessionExecution.sandboxOs,
      resolvedTools: targetSessionExecution.tools,
      resolvedFirstPartyMcpTools: targetSessionExecution.firstPartyMcpTools ?? [
        ...DEFAULT_FIRST_PARTY_MCP_TOOLS,
      ],
      resolvedFirstPartyMcpPermissions: targetSessionExecution.firstPartyMcpPermissions ?? [
        ...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
      ],
      resolvedVariableSet: null,
      resolvedRig: null,
      resolvedSlackBotConnection: null,
      targetSessionExecution,
      generatedSessionBinding: null,
      personalConnectionDelegations: [],
      personalResourceAuthoritySubjectId,
      causalHumanSubjectId:
        personalResourceAuthoritySubjectId ?? causalHumanAuthority?.subjectId ?? null,
      causalHumanAuthority,
      xaiProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
      xaiAuthoritySubjectId: null,
      connectionAuthoritySubjectId: null,
      triggerInitiator: { kind: "service", subjectId: "scheduler" },
      agentRunUsageIdempotencyKey: null,
      incidentPreflightRequired: false,
      alertOccurrenceLabels: null,
    },
  });
  await bindScheduledTaskRunSessionInTransaction(client.db, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    runId: run.id,
    sessionId: input.sessionId,
  });
  const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
    workspaceId: task.workspaceId,
    runId: run.id,
  });
  if (!accepted) throw new Error("scheduled run is missing its accepted execution");
  return await addSessionSystemUpdateWithSourceMutation(
    client.db,
    {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      sessionId: input.sessionId,
      kind: "scheduled_occurrence",
      classification: "info",
      sourceId: run.id,
      dedupeKey: `scheduled-task-run:${run.id}`,
      summary: task.agentConfig.prompt,
      payload: {
        type: "scheduled_occurrence",
        text: task.agentConfig.prompt,
        scheduledTaskId: task.id,
        scheduledTaskRunId: run.id,
      },
      lineage: {
        scheduledTaskId: task.id,
        scheduledTaskRunId: run.id,
        causalHumanSubjectId: accepted.causalHumanSubjectId,
      },
      personalConnectionDelegations: accepted.personalConnectionDelegations,
      xaiProviderAccountAuthoritySnapshot: accepted.xaiProviderAccountAuthoritySnapshot,
      scheduledTaskRunId: run.id,
    },
    async (tx, wakeEventId) => {
      if (!wakeEventId) throw new Error("scheduled occurrence produced no wake event");
      await settleScheduledTaskRunInTransaction(tx, {
        workspaceId: task.workspaceId,
        runId: run.id,
        sessionId: input.sessionId,
        triggerEventId: wakeEventId,
        status: "dispatched",
      });
    },
  );
}

describe("migrations 0353-0355 automatic session title policy fence", () => {
  test("use a short rolling fence, concurrent candidate index, and bounded resumable quarantine", async () => {
    const fence = await readFile(fenceMigrationUrl, "utf8");
    const quarantineIndex = await readFile(quarantineIndexMigrationUrl, "utf8");
    const quarantine = await readFile(quarantineMigrationUrl, "utf8");
    const provisionRolesSource = await readFile(provisionRolesUrl, "utf8");
    expect(fence.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(fence).not.toContain("LOCK TABLE sessions");
    expect(fence).not.toContain("ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY");
    expect(fence).not.toContain("ALTER TABLE sessions FORCE ROW LEVEL SECURITY");
    expect(fence).not.toMatch(/\bUPDATE sessions\b/i);
    expect(fence).toContain("sessions_automatic_title_quarantine_v1");
    expect(fence).toContain("session_events_automatic_title_quarantine_v1");
    expect(fence).toContain("'session_events'::regclass");
    expect(fence).toContain(
      "CREATE TABLE opengeni_private.automatic_session_title_fanout_outbox_v1",
    );
    expect(fence).not.toContain("CREATE TABLE automatic_session_title_fanout_outbox_v1");
    expect(FORCE_RLS_TABLES).not.toContain("automatic_session_title_fanout_outbox_v1");
    expect(PROTECTED_NO_DIRECT_DML_TABLES).not.toContain(
      "automatic_session_title_fanout_outbox_v1",
    );
    expect(fence).toContain("automatic_title_fanout_workspace_event_fk");
    expect(fence).toContain("automatic_title_fanout_pending_idx");
    expect(fence).toContain("enqueue_automatic_session_title_fanout_v1");
    expect(fence).toContain("SECURITY INVOKER");
    expect(fence).toContain("claim_automatic_session_title_fanout_v1");
    expect(fence).toContain("mark_automatic_session_title_fanout_delivered_v1");
    expect(fence).toContain("mark_automatic_session_title_fanout_failed_v1");
    expect(provisionRolesSource).toContain(
      "GRANT EXECUTE ON FUNCTION opengeni_private.enqueue_automatic_session_title_fanout_v1(uuid, uuid, uuid, uuid) TO %I",
    );
    expect(provisionRolesSource).toContain(
      "GRANT EXECUTE ON FUNCTION opengeni_private.enforce_automatic_session_title_policy_v1() TO %I",
    );
    expect(provisionRolesSource).toContain(
      "REVOKE ALL PRIVILEGES ON TABLE opengeni_private.automatic_session_title_fanout_outbox_v1 FROM %I",
    );
    expect(fence).toContain("opengeni.migration_application_roles");
    expect(fence).toContain("pg_catalog.jsonb_array_elements_text(configured_roles)");
    expect(fence).not.toContain("TO opengeni_app");
    expect(provisionRolesSource).not.toContain(
      "REVOKE EXECUTE ON FUNCTION opengeni_private.claim_automatic_session_title_fanout_v1(integer) FROM %I",
    );
    expect(fence).toContain("FOR UPDATE SKIP LOCKED");
    expect(fence).toContain("pg_catalog.pg_get_userbyid(relation.relowner)");
    expect(fence).toContain("opengeni.automatic_session_title_quarantine_v1");
    expect(fence).toContain(
      "DROP FUNCTION IF EXISTS acquire_automatic_session_title_quarantine_fences_v1(integer)",
    );
    expect(RUNTIME_TARGET_SCHEMA_FORBIDDEN_ROUTINES).toContain(
      "acquire_automatic_session_title_quarantine_fences_v1(integer)",
    );
    expect(fence).toContain("CREATE FUNCTION acquire_automatic_session_title_quarantine_fences_v1");
    expect(fence).toContain("RETURNS uuid[]");
    expect(fence).toMatch(
      /ORDER BY bounded\.workspace_id[\s\S]*acquire_session_tenancy_fence\(workspace_id_value\)/u,
    );
    expect(fence).toContain(
      "REVOKE ALL ON FUNCTION\n  acquire_automatic_session_title_quarantine_fences_v1(integer)",
    );
    expect(fence).toContain("opengeni.automatic_session_title_v1_candidate");
    expect(fence).toContain("candidate IS DISTINCT FROM NEW.title");
    expect(fence).toContain("NEW.title IS DISTINCT FROM 'New conversation'");
    expect(fence).toContain("TG_OP = 'INSERT'");
    expect(fence).toContain("NEW.title := OLD.title");
    expect(fence).toContain("NEW.title_source := OLD.title_source");
    expect(fence).toContain("BEFORE INSERT OR UPDATE OF title, title_source");
    expect(fence).toContain("ON sessions");
    expect(fence).not.toContain("public.sessions");
    const triggerBody = fence.slice(
      fence.indexOf(
        "CREATE OR REPLACE FUNCTION opengeni_private.enforce_automatic_session_title_policy_v1()",
      ),
      fence.indexOf(
        "REVOKE ALL ON FUNCTION opengeni_private.enforce_automatic_session_title_policy_v1()",
      ),
    );
    expect(triggerBody).not.toContain("RAISE EXCEPTION");
    expect(fence).toContain(
      "REVOKE ALL ON FUNCTION opengeni_private.enforce_automatic_session_title_policy_v1()",
    );
    expect(fence).toContain("FROM PUBLIC");
    expect(fence).toContain("'enforce_automatic_session_title_policy_v1()'");

    expect(
      quarantineIndex.startsWith(
        "-- deployment-mode: rolling\n-- opengeni:concurrent-index lock-timeout=5s\n",
      ),
    ).toBe(true);
    expect(quarantineIndex).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS");
    expect(quarantineIndex).toContain("sessions_automatic_title_quarantine_v1_idx");
    expect(quarantineIndex).toContain("ON sessions (id)");
    expect(quarantineIndex).toContain("title_source IS DISTINCT FROM 'user'");
    expect(
      parseConcurrentIndexMigration(
        "0354_automatic_session_title_quarantine_index.sql",
        quarantineIndex,
      ),
    ).toMatchObject({
      indexName: "sessions_automatic_title_quarantine_v1_idx",
      lockTimeout: "5s",
      skipWhenValid: false,
    });

    expect(
      quarantine.startsWith(
        "-- deployment-mode: rolling\n-- opengeni:batched-backfill batch-size=500 lock-timeout=1s statement-timeout=10s\n",
      ),
    ).toBe(true);
    expect(quarantine).toContain("500::integer AS batch_size");
    expect(quarantine).toContain("LIMIT 500");
    expect(quarantine).toContain("session.workspace_id = ANY(scope.workspace_ids)");
    expect(quarantine).toContain("FOR UPDATE OF session");
    expect(quarantine.indexOf("acquire_automatic_session_title_quarantine_fences_v1")).toBeLessThan(
      quarantine.indexOf("FOR UPDATE OF session"),
    );
    expect(quarantine).toContain("last_sequence = session.last_sequence + 1");
    expect(quarantine).toContain("INSERT INTO session_events");
    expect(quarantine).toContain("'session.title_set'");
    expect(quarantine).toContain("opengeni_private.enqueue_automatic_session_title_fanout_v1");
    expect(quarantine).toContain("SELECT session_id AS id");
    expect(quarantine).not.toContain("updated_at");
    expect(quarantine).not.toContain("SKIP LOCKED");
    expect(quarantine).not.toContain("ALTER TABLE");
    expect(quarantine).not.toContain("LOCK TABLE");
  });

  test("keeps candidate discovery on the concurrent partial index after cleaned rows disappear", async () => {
    const database = shared;
    if (!database) return;

    const [index] = await database.admin<
      Array<{ valid: boolean; ready: boolean; predicate: string | null }>
    >`
      select
        candidate.indisvalid as valid,
        candidate.indisready as ready,
        pg_catalog.pg_get_expr(candidate.indpred, candidate.indrelid) as predicate
      from pg_catalog.pg_index candidate
      join pg_catalog.pg_class relation on relation.oid = candidate.indexrelid
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = current_schema()
        and relation.relname = 'sessions_automatic_title_quarantine_v1_idx'
    `;
    expect(index).toMatchObject({ valid: true, ready: true });
    expect(index?.predicate).toContain("title_source IS DISTINCT FROM 'user'::text");
    expect(index?.predicate).toContain("title IS DISTINCT FROM 'New conversation'::text");

    const plan = await database.admin.begin(async (transaction) => {
      await transaction`set local enable_seqscan = off`;
      return await transaction.unsafe<Array<{ "QUERY PLAN": string }>>(`
        explain (costs off)
        select session.id
        from sessions session
        where session.title_source is distinct from 'user'
          and (
            session.title is distinct from 'New conversation'
            or session.title_source is distinct from 'agent'
          )
        order by session.id
        limit 500
      `);
    });
    expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
      "sessions_automatic_title_quarantine_v1_idx",
    );
  });

  test("quarantines legacy automatic titles while preserving user-edited titles", async () => {
    const database = shared;
    if (!database) return;

    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `title-cutover-account-${suffix}`,
      accountName: "Title cutover",
      workspaceExternalSource: "test",
      workspaceExternalId: `title-cutover-workspace-${suffix}`,
      workspaceName: "Title cutover",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const legacy = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "legacy automatic title",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const human = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "human title",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const unsafeTitle = "Password: swordfish";
    await database.admin`alter table sessions disable trigger sessions_automatic_title_policy_v1_fence`;
    try {
      await database.admin`
        update sessions
        set title = ${unsafeTitle}, title_source = 'agent'
        where id = ${legacy.id}
      `;
      await database.admin`
        update sessions
        set title = 'Human incident review', title_source = 'user'
        where id = ${human.id}
      `;
    } finally {
      await database.admin`alter table sessions enable trigger sessions_automatic_title_policy_v1_fence`;
    }

    const [unsafeEvent] = await appendSessionEvents(client.db, grant.workspaceId!, legacy.id, [
      {
        type: "session.title_set",
        payload: { title: unsafeTitle, source: "agent" },
      },
    ]);
    expect(unsafeEvent?.payload).toEqual({ title: unsafeTitle, source: "agent" });

    expect(await drainQuarantine(database, await quarantineStatement())).toBe(1);
    const quarantined = await getSession(client.db, grant.workspaceId!, legacy.id);
    expect(quarantined).toMatchObject({
      title: "New conversation",
      titleSource: "agent",
      lastSequence: (unsafeEvent?.sequence ?? 0) + 1,
    });
    expect(await getSession(client.db, grant.workspaceId!, human.id)).toMatchObject({
      title: "Human incident review",
      titleSource: "user",
    });

    const titleEvents = await database.admin<
      Array<{ sequence: number; payload: { title?: unknown; source?: unknown } }>
    >`
      select sequence, payload
      from session_events
      where session_id = ${legacy.id}
        and type = 'session.title_set'
      order by sequence
    `;
    expect(titleEvents.at(-1)).toMatchObject({
      sequence: quarantined?.lastSequence,
      payload: { title: "New conversation", source: "agent" },
    });
    // A pre-policy browser applies every replayed title event without comparing
    // it to the fetched row sequence. The migration's final event must still
    // leave that old reducer on the safe projection.
    expect(
      titleEvents.reduce(
        (title, event) => (typeof event.payload.title === "string" ? event.payload.title : title),
        quarantined?.title ?? null,
      ),
    ).toBe("New conversation");

    const [fanout] = await claimAutomaticSessionTitleFanout(client.db, 10);
    expect(fanout).toMatchObject({
      event: {
        workspaceId: grant.workspaceId,
        sessionId: legacy.id,
        sequence: quarantined?.lastSequence,
        type: "session.title_set",
        payload: { title: "New conversation", source: "agent" },
      },
    });
    expect(fanout && (await markAutomaticSessionTitleFanoutDelivered(client.db, fanout))).toBe(
      true,
    );
    expect(await claimAutomaticSessionTitleFanout(client.db, 10)).toEqual([]);
  }, 180_000);

  test("quarantines under the non-superuser, non-BYPASSRLS migration owner", async () => {
    const owned = await acquireOwnerMigratedTestDatabase("automatic-title-quarantine-owner");
    if (!owned) {
      if (requireRealDatabase) throw new Error("real owner-migrated database unavailable");
      return;
    }

    let ownerClient: DbClient | null = null;
    let ownerSql: postgres.Sql | null = null;
    try {
      await migrate(owned.ownerUrl);
      ownerClient = createDb(owned.ownerUrl, { max: 4 });
      const suffix = crypto.randomUUID();
      const access = await bootstrapWorkspace(ownerClient.db, {
        accountExternalSource: "test",
        accountExternalId: `title-owner-account-${suffix}`,
        accountName: "Title owner quarantine",
        workspaceExternalSource: "test",
        workspaceExternalId: `title-owner-workspace-${suffix}`,
        workspaceName: "Title owner quarantine",
        subjectId: `subject-${suffix}`,
      });
      const grant = access.workspaceGrants[0]!;
      const session = await createSession(ownerClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        initialMessage: "legacy owner title",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
      });

      await owned.admin`alter table sessions disable trigger sessions_automatic_title_policy_v1_fence`;
      try {
        await owned.admin`
          update sessions
          set title = 'DATABASE_APIKEY=swordfish', title_source = 'agent'
          where id = ${session.id}
        `;
      } finally {
        await owned.admin`alter table sessions enable trigger sessions_automatic_title_policy_v1_fence`;
      }

      const [posture] = await owned.admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
        select rolsuper as superuser, rolbypassrls as "bypassRls"
        from pg_roles
        where rolname = ${owned.ownerRole}
      `;
      expect(posture).toEqual({ superuser: false, bypassRls: false });

      ownerSql = postgres(owned.ownerUrl, { max: 1, prepare: false });
      const rows = await ownerSql.begin(async (transaction) => {
        await transaction`select
          set_config('lock_timeout', '1s', true),
          set_config('statement_timeout', '10s', true)`;
        return await transaction.unsafe<Array<{ id: string }>>(await quarantineStatement());
      });
      expect([...rows]).toEqual([{ id: session.id }]);

      expect(await getSession(ownerClient.db, grant.workspaceId!, session.id)).toMatchObject({
        title: "New conversation",
        titleSource: "agent",
      });
      const events = await owned.admin<
        Array<{ type: string; payload: { title?: unknown; source?: unknown } }>
      >`
        select type, payload
        from session_events
        where session_id = ${session.id}
        order by sequence desc
        limit 1
      `;
      expect([...events]).toEqual([
        {
          type: "session.title_set",
          payload: { title: "New conversation", source: "agent" },
        },
      ]);
    } finally {
      await ownerSql?.end({ timeout: 5 }).catch(() => undefined);
      await ownerClient?.close().catch(() => undefined);
      await owned.release();
    }
  }, 900_000);

  test("commits bounded progress, rolls back a failed batch, and resumes safely", async () => {
    const database = shared;
    if (!database) return;

    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `title-quarantine-rollback-account-${suffix}`,
      accountName: "Title quarantine rollback",
      workspaceExternalSource: "test",
      workspaceExternalId: `title-quarantine-rollback-workspace-${suffix}`,
      workspaceName: "Title quarantine rollback",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const sessions = [];
    for (let index = 0; index < 3; index += 1) {
      sessions.push(
        await createSession(client.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          initialMessage: `legacy automatic title ${index}`,
          resources: [],
          metadata: {},
          model: "scripted-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
        }),
      );
    }
    const ids = sessions.map((session) => session.id);
    await database.admin`alter table sessions disable trigger sessions_automatic_title_policy_v1_fence`;
    try {
      await database.admin`
        update sessions
        set title = 'CLIENT_SECRET=secretword', title_source = 'agent'
        where id = any(${ids}::uuid[])
      `;
    } finally {
      await database.admin`alter table sessions enable trigger sessions_automatic_title_policy_v1_fence`;
    }

    const oneRowBatch = await quarantineStatement(1);
    expect((await runQuarantineBatch(database, oneRowBatch)).length).toBe(1);
    const safeAfterFirst = await database.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from sessions
      where id = any(${ids}::uuid[])
        and title = 'New conversation'
        and title_source = 'agent'
    `;
    expect(safeAfterFirst[0]?.count).toBe(1);
    const fanoutAfterFirst = await database.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from opengeni_private.automatic_session_title_fanout_outbox_v1
      where session_id = any(${ids}::uuid[])
    `;
    expect(fanoutAfterFirst[0]?.count).toBe(1);

    await expect(runQuarantineBatch(database, oneRowBatch, true)).rejects.toThrow(
      "forced title quarantine batch failure",
    );
    const safeAfterFailure = await database.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from sessions
      where id = any(${ids}::uuid[])
        and title = 'New conversation'
        and title_source = 'agent'
    `;
    expect(safeAfterFailure[0]?.count).toBe(1);
    const fanoutAfterFailure = await database.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from opengeni_private.automatic_session_title_fanout_outbox_v1
      where session_id = any(${ids}::uuid[])
    `;
    expect(fanoutAfterFailure[0]?.count).toBe(1);

    expect(await drainQuarantine(database, oneRowBatch)).toBe(2);
    const remaining = await database.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from sessions
      where id = any(${ids}::uuid[])
        and (title <> 'New conversation' or title_source <> 'agent')
    `;
    expect(remaining[0]?.count).toBe(0);
    const finalFanout = await database.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from opengeni_private.automatic_session_title_fanout_outbox_v1
      where session_id = any(${ids}::uuid[])
    `;
    expect(finalFanout[0]?.count).toBe(3);
  }, 180_000);

  test("quarantine batches do not wait for concurrent readers", async () => {
    const database = shared;
    if (!database) return;

    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `title-quarantine-reader-account-${suffix}`,
      accountName: "Title quarantine reader",
      workspaceExternalSource: "test",
      workspaceExternalId: `title-quarantine-reader-workspace-${suffix}`,
      workspaceName: "Title quarantine reader",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "legacy reader title",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await database.admin`alter table sessions disable trigger sessions_automatic_title_policy_v1_fence`;
    try {
      await database.admin`
        update sessions
        set title = 'GITHUB_TOKEN=sesame', title_source = 'agent'
        where id = ${session.id}
      `;
    } finally {
      await database.admin`alter table sessions enable trigger sessions_automatic_title_policy_v1_fence`;
    }

    const reader = postgres(database.adminUrl, { max: 1, prepare: false });
    const writer = postgres(database.adminUrl, { max: 1, prepare: false });
    let readerReady!: () => void;
    let releaseReader!: () => void;
    const ready = new Promise<void>((resolve) => {
      readerReady = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });
    const heldReader = reader.begin(async (transaction) => {
      await transaction`select title from sessions where id = ${session.id}`;
      readerReady();
      await release;
    });
    await ready;
    try {
      await writer`select set_config('statement_timeout', '2s', false)`;
      expect((await writer.unsafe(await quarantineStatement())).length).toBeGreaterThan(0);
    } finally {
      releaseReader();
      await heldReader;
      await Promise.all([reader.end(), writer.end()]);
    }
    expect(await getSession(client.db, grant.workspaceId!, session.id)).toMatchObject({
      title: "New conversation",
      titleSource: "agent",
    });
  }, 180_000);

  test("keeps the pre-policy runtime posture ready with invoker-only compatibility grants", async () => {
    const database = shared;
    if (!database) return;

    const routines = await database.admin<
      Array<{
        name: string;
        appExecute: boolean;
        publicExecute: boolean;
        securityDefiner: boolean;
      }>
    >`
      select
        (procedure.proname || '(' || pg_catalog.oidvectortypes(procedure.proargtypes) || ')')::text
          as name,
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as "appExecute",
        exists (
          select 1
          from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute",
        procedure.prosecdef as "securityDefiner"
      from pg_catalog.pg_proc procedure
      join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'opengeni_private'
        and procedure.proname = any(array[
          'claim_automatic_session_title_fanout_v1',
          'mark_automatic_session_title_fanout_delivered_v1',
          'mark_automatic_session_title_fanout_failed_v1',
          'enqueue_automatic_session_title_fanout_v1',
          'enforce_automatic_session_title_policy_v1'
        ]::text[])
      order by name
    `;
    expect([...routines]).toEqual([
      {
        name: "claim_automatic_session_title_fanout_v1(integer)",
        appExecute: true,
        publicExecute: false,
        securityDefiner: true,
      },
      {
        name: "enforce_automatic_session_title_policy_v1()",
        appExecute: true,
        publicExecute: false,
        securityDefiner: false,
      },
      {
        name: "enqueue_automatic_session_title_fanout_v1(uuid, uuid, uuid, uuid)",
        appExecute: true,
        publicExecute: false,
        securityDefiner: false,
      },
      {
        name: "mark_automatic_session_title_fanout_delivered_v1(uuid, uuid)",
        appExecute: true,
        publicExecute: false,
        securityDefiner: true,
      },
      {
        name: "mark_automatic_session_title_fanout_failed_v1(uuid, uuid, text)",
        appExecute: true,
        publicExecute: false,
        securityDefiner: true,
      },
    ]);
    const [appOutboxPrivileges] = await database.admin<
      Array<{
        select: boolean;
        insert: boolean;
        update: boolean;
        delete: boolean;
      }>
    >`
      select
        has_table_privilege(
          'opengeni_app',
          'opengeni_private.automatic_session_title_fanout_outbox_v1',
          'SELECT'
        ) as select,
        has_table_privilege(
          'opengeni_app',
          'opengeni_private.automatic_session_title_fanout_outbox_v1',
          'INSERT'
        ) as insert,
        has_table_privilege(
          'opengeni_app',
          'opengeni_private.automatic_session_title_fanout_outbox_v1',
          'UPDATE'
        ) as update,
        has_table_privilege(
          'opengeni_app',
          'opengeni_private.automatic_session_title_fanout_outbox_v1',
          'DELETE'
        ) as delete
    `;
    expect(appOutboxPrivileges).toEqual({
      select: false,
      insert: false,
      update: false,
      delete: false,
    });
    const executeAsAppRole = async (statement: string) =>
      await database.admin.begin(async (transaction) => {
        await transaction`select set_config('statement_timeout', '5s', true)`;
        await transaction.unsafe("set local role opengeni_app");
        return await transaction.unsafe(statement);
      });
    await expect(
      executeAsAppRole(`
          select opengeni_private.enqueue_automatic_session_title_fanout_v1(
            gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()
          )
        `),
    ).rejects.toThrow(/permission denied for table automatic_session_title_fanout_outbox_v1/iu);
    await expect(
      executeAsAppRole("select opengeni_private.enforce_automatic_session_title_policy_v1()"),
    ).rejects.toThrow(/trigger functions can only be called as triggers/iu);
  }, 180_000);

  test("keeps custom old binaries ready immediately after 0353 and converges deferred roles", async () => {
    const blank = await acquireBlankTestDatabase("automatic-title-custom-role-rolling");
    if (!blank) {
      if (requireRealDatabase) throw new Error("real blank database unavailable");
      return;
    }

    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const customRole = `og_title_custom_${suffix}`;
    const deferredRole = `og_title_deferred_${suffix}`;
    const customPassword = crypto.randomUUID();
    const deferredPassword = crypto.randomUUID();
    const admin = postgres(blank.databaseUrl, { max: 1, prepare: false });
    let customClient: DbClient | null = null;
    let deferredClient: DbClient | null = null;

    const roleUrl = (role: string, password: string) => {
      const value = new URL(blank.databaseUrl);
      value.username = role;
      value.password = password;
      return value.toString();
    };
    const titleRoutineNames = new Set([
      "claim_automatic_session_title_fanout_v1(integer)",
      "enforce_automatic_session_title_policy_v1()",
      "enqueue_automatic_session_title_fanout_v1(uuid, uuid, uuid, uuid)",
      "mark_automatic_session_title_fanout_delivered_v1(uuid, uuid)",
      "mark_automatic_session_title_fanout_failed_v1(uuid, uuid, text)",
    ]);
    const postureOptions = (expectedRole: string) => ({
      rlsStrategy: "force" as const,
      expectedRole,
      targetSchema: "public",
    });

    try {
      await admin.unsafe(
        `CREATE TABLE schema_migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`,
      );
      const migrationFiles = (await readdir(migrationsDirectoryUrl))
        .filter((file) => file.endsWith(".sql"))
        .sort();
      const heldMigrations = migrationFiles.filter(
        (file) =>
          Buffer.compare(
            Buffer.from(file, "utf8"),
            Buffer.from("0353_automatic_session_title_policy_fence.sql", "utf8"),
          ) >= 0,
      );
      for (const file of heldMigrations) {
        await admin`insert into schema_migrations (name) values (${file})`;
      }

      await migrate(blank.databaseUrl, undefined, {
        applicationDatabaseRoles: [customRole],
      });
      await provisionRoles(blank.databaseUrl, {
        appRole: customRole,
        appPassword: customPassword,
      });

      await admin`
        delete from schema_migrations
        where name = '0353_automatic_session_title_policy_fence.sql'
      `;
      await migrate(blank.databaseUrl, undefined, {
        applicationDatabaseRoles: [customRole, deferredRole],
      });

      expect(
        Array.from(
          await admin<Array<{ exists: boolean }>>`
          select exists(
            select 1 from pg_roles where rolname = ${deferredRole}
          ) as exists
        `,
        ),
      ).toEqual([{ exists: false }]);

      customClient = createDb(roleUrl(customRole, customPassword), { max: 1 });
      const customPosture = await inspectRuntimeDatabasePosture(
        customClient.db,
        postureOptions(customRole),
      );
      expect(
        customPosture.tables.some(
          (table) => table.name === "automatic_session_title_fanout_outbox_v1",
        ),
      ).toBe(false);
      expect(
        customPosture.privateTables.find(
          (table) => table.name === "automatic_session_title_fanout_outbox_v1",
        ),
      ).toMatchObject({
        rlsEnabled: true,
        rlsForced: true,
        rlsActive: true,
        policyCount: 1,
        select: false,
        insert: false,
        update: false,
        delete: false,
      });
      expect(evaluateRuntimeDatabasePosture(customPosture, postureOptions(customRole))).toEqual([]);

      // Model the complete pre-policy posture with its original target-table
      // contract and private-routine generic loop. The current evaluator covers
      // every unchanged identity/schema/table/routine invariant after removing
      // only the new title catalog, then the old generic loop evaluates all five
      // newly visible private routines exactly as the old binary did.
      const legacyPosture = {
        ...customPosture,
        privateTables: customPosture.privateTables.filter(
          (table) => table.name !== "automatic_session_title_fanout_outbox_v1",
        ),
        privateRoutines: customPosture.privateRoutines.filter(
          (routine) => !titleRoutineNames.has(routine.name),
        ),
      };
      expect(evaluateRuntimeDatabasePosture(legacyPosture, postureOptions(customRole))).toEqual([]);
      expect(
        customPosture.privateRoutines
          .filter((routine) => titleRoutineNames.has(routine.name))
          .map((routine) => ({
            name: routine.name,
            execute: routine.execute,
            publicExecute: routine.publicExecute,
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      ).toEqual(
        [...titleRoutineNames]
          .sort((left, right) => left.localeCompare(right))
          .map((name) => ({ name, execute: true, publicExecute: false })),
      );

      await provisionRoles(blank.databaseUrl, {
        appRole: deferredRole,
        appPassword: deferredPassword,
      });
      deferredClient = createDb(roleUrl(deferredRole, deferredPassword), {
        max: 1,
      });
      const deferredPosture = await inspectRuntimeDatabasePosture(
        deferredClient.db,
        postureOptions(deferredRole),
      );
      expect(evaluateRuntimeDatabasePosture(deferredPosture, postureOptions(deferredRole))).toEqual(
        [],
      );
      expect(
        deferredPosture.privateTables.find(
          (table) => table.name === "automatic_session_title_fanout_outbox_v1",
        ),
      ).toMatchObject({
        select: false,
        insert: false,
        update: false,
        delete: false,
      });
    } finally {
      await customClient?.close().catch(() => undefined);
      await deferredClient?.close().catch(() => undefined);
      for (const role of [customRole, deferredRole]) {
        await admin.unsafe(`DROP OWNED BY "${role}"`).catch(() => undefined);
        await admin.unsafe(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
      }
      await admin.end().catch(() => undefined);
      await blank.release();
    }
  }, 900_000);

  test("keeps the pre-policy scheduler writer safe and non-throwing during rollout", async () => {
    const database = shared;
    if (!database) return;

    const [functionAcl] = await database.admin<Array<{ publicExecute: boolean }>>`
      select
        exists (
          select 1
          from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'opengeni_private'
        and procedure.proname = 'enforce_automatic_session_title_policy_v1'`;
    expect(functionAcl).toEqual({ publicExecute: false });

    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `title-fence-account-${suffix}`,
      accountName: "Title fence",
      workspaceExternalSource: "test",
      workspaceExternalId: `title-fence-workspace-${suffix}`,
      workspaceName: "Title fence",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "Password：hunter2 investigate the callback",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });

    const [legacyResult] = await database.admin<Array<{ title: string; titleSource: string }>>`
      update sessions
      set title = ${"Password：hunter2 investigate the callback"},
          title_source = 'agent'
      where id = ${session.id}
      returning title, title_source as "titleSource"
    `;
    expect(legacyResult).toEqual({ title: "New conversation", titleSource: "agent" });
    const legacyTitleEvents = await appendSessionEvents(client.db, grant.workspaceId!, session.id, [
      {
        type: "session.title_set",
        payload: { title: legacyResult!.title, source: "agent" },
      },
    ]);
    expect(legacyTitleEvents[0]?.payload).toEqual({
      title: "New conversation",
      source: "agent",
    });
    const delivered = await addAcceptedScheduledOccurrence({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
    });
    expect(delivered).toMatchObject({
      added: true,
      reason: "added",
      update: { kind: "scheduled_occurrence" },
    });
    expect(await getSession(client.db, grant.workspaceId!, session.id)).toMatchObject({
      title: "New conversation",
      titleSource: "agent",
    });

    expect(
      await updateSessionTitle(client.db, {
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        title: "OAuth callback failures",
        source: "agent",
      }),
    ).toEqual({ updated: true, title: "OAuth callback failures" });

    expect(
      await updateSessionTitle(client.db, {
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        title: "Stale scheduled fallback replacement",
        source: "agent",
        expectedCurrent: { title: "New conversation", source: "agent" },
      }),
    ).toEqual({ updated: false, title: "OAuth callback failures" });

    expect(
      await updateSessionTitle(client.db, {
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        title: "Debug token sk-proj-abc\u200B123456789XYZ",
        source: "agent",
      }),
    ).toEqual({ updated: false, title: "OAuth callback failures" });

    await database.admin`
      update sessions
      set title = 'Human incident review', title_source = 'user'
      where id = ${session.id}
    `;
    expect(
      await updateSessionTitle(client.db, {
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        title: "Agent retry title",
        source: "agent",
      }),
    ).toEqual({ updated: false, title: "Human incident review" });
  });
});
