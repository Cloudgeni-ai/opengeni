import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  addSessionSystemUpdateWithSourceMutation,
  appendSessionEvents,
  bindScheduledTaskRunSessionInTransaction,
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  createScheduledTaskRun,
  createSession,
  getScheduledTargetSessionExecution,
  getScheduledTaskPersonalResourceAuthoritySubject,
  getScheduledTaskRevisionAuthority,
  getScheduledTaskRunAcceptedExecution,
  getSession,
  settleScheduledTaskRunInTransaction,
  updateSessionTitle,
  type DbClient,
} from "../src/index";

const fenceMigrationUrl = new URL(
  "../drizzle/0345_automatic_session_title_policy_fence.sql",
  import.meta.url,
);
const quarantineMigrationUrl = new URL(
  "../drizzle/0346_automatic_session_title_quarantine.sql",
  import.meta.url,
);

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
  return batchSize === 500 ? statement : statement.replace("LIMIT 500", `LIMIT ${batchSize}`);
}

async function runQuarantineBatch(
  database: SharedTestDatabase,
  statement: string,
): Promise<Array<{ id: string }>> {
  return await database.admin.begin(async (transaction) => {
    await transaction`select
      set_config('lock_timeout', '1s', true),
      set_config('statement_timeout', '10s', true)`;
    return await transaction.unsafe<Array<{ id: string }>>(statement);
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

describe("migrations 0345-0346 automatic session title policy fence", () => {
  test("use a short rolling fence followed by a bounded resumable quarantine", async () => {
    const fence = await readFile(fenceMigrationUrl, "utf8");
    const quarantine = await readFile(quarantineMigrationUrl, "utf8");
    expect(fence.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(fence).not.toContain("LOCK TABLE sessions");
    expect(fence).not.toContain("ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY");
    expect(fence).not.toContain("ALTER TABLE sessions FORCE ROW LEVEL SECURITY");
    expect(fence).not.toMatch(/\bUPDATE sessions\b/i);
    expect(fence).toContain("sessions_automatic_title_quarantine_v1");
    expect(fence).toContain("pg_catalog.pg_get_userbyid(relation.relowner)");
    expect(fence).toContain("opengeni.automatic_session_title_quarantine_v1");
    expect(fence).toContain("opengeni.automatic_session_title_v1_candidate");
    expect(fence).toContain("candidate IS DISTINCT FROM NEW.title");
    expect(fence).toContain("NEW.title IS DISTINCT FROM 'New conversation'");
    expect(fence).toContain("TG_OP = 'INSERT'");
    expect(fence).toContain("NEW.title := OLD.title");
    expect(fence).toContain("NEW.title_source := OLD.title_source");
    expect(fence).toContain("BEFORE INSERT OR UPDATE OF title, title_source");
    expect(fence).toContain("ON sessions");
    expect(fence).not.toContain("public.sessions");
    expect(fence).not.toContain("RAISE EXCEPTION");
    expect(fence).toContain(
      "REVOKE ALL ON FUNCTION opengeni_private.enforce_automatic_session_title_policy_v1()",
    );
    expect(fence).toContain("FROM PUBLIC");

    expect(
      quarantine.startsWith(
        "-- deployment-mode: rolling\n-- opengeni:batched-backfill batch-size=500 lock-timeout=1s statement-timeout=10s\n",
      ),
    ).toBe(true);
    expect(quarantine).toContain("LIMIT 500");
    expect(quarantine).toContain("FOR UPDATE OF session");
    expect(quarantine).toContain("RETURNING session.id");
    expect(quarantine).not.toContain("SKIP LOCKED");
    expect(quarantine).not.toContain("ALTER TABLE");
    expect(quarantine).not.toContain("LOCK TABLE");
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
    await database.admin`alter table sessions disable trigger sessions_automatic_title_policy_v1_fence`;
    try {
      await database.admin`
        update sessions
        set title = 'Password: swordfish', title_source = 'agent'
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

    expect(await drainQuarantine(database, await quarantineStatement())).toBe(1);
    expect(await getSession(client.db, grant.workspaceId!, legacy.id)).toMatchObject({
      title: "New conversation",
      titleSource: "agent",
    });
    expect(await getSession(client.db, grant.workspaceId!, human.id)).toMatchObject({
      title: "Human incident review",
      titleSource: "user",
    });
  }, 180_000);

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

    const failingBatch = oneRowBatch.replace(
      "SET title = 'New conversation', title_source = 'agent'",
      "SET title = 'New conversation', title_source = 'invalid'",
    );
    await expect(runQuarantineBatch(database, failingBatch)).rejects.toThrow();
    const safeAfterFailure = await database.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from sessions
      where id = any(${ids}::uuid[])
        and title = 'New conversation'
        and title_source = 'agent'
    `;
    expect(safeAfterFailure[0]?.count).toBe(1);

    expect(await drainQuarantine(database, oneRowBatch)).toBe(2);
    const remaining = await database.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from sessions
      where id = any(${ids}::uuid[])
        and (title <> 'New conversation' or title_source <> 'agent')
    `;
    expect(remaining[0]?.count).toBe(0);
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
