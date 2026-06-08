import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  createScheduledTaskRun,
  createApiKey,
  createSession,
  createTurn,
  dbSql,
  finishTurn,
  findActiveApiKeyByHash,
  getLatestRunState,
  getSession,
  listScheduledTaskRuns,
  listScheduledTasks,
  listSessionEvents,
  saveRunState,
  setSessionStatus,
  updateScheduledTask,
  updateScheduledTaskRun,
  withRlsContext,
} from "@opengeni/db";
import type { AccessGrant } from "@opengeni/contracts";
import { expectContiguousSequences, startTestServices, type TestServices } from "@opengeni/testing";

describe("DB integration", () => {
  let services: TestServices;
  let dbClient: ReturnType<typeof createDb>;

  beforeAll(async () => {
    services = await startTestServices({ temporal: false });
    await services.migrate();
    dbClient = createDb(services.databaseUrl);
  }, 180_000);

  afterAll(async () => {
    await dbClient?.close();
    await services?.down();
  }, 60_000);

  test("migrates, creates sessions, and replays ordered events", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "inspect this",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const events = await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [
      { type: "session.created" },
      { type: "user.message", payload: { text: "inspect this" }, clientEventId: "client-1" },
      { type: "session.status.changed", payload: { status: "queued" } },
    ]);
    expectContiguousSequences(events);
    expect(await listSessionEvents(dbClient.db, grant.workspaceId, session.id)).toHaveLength(3);
    expect(await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 1)).toHaveLength(2);
  });

  test("serializes concurrent event appends into contiguous sequence numbers", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "concurrency",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await Promise.all(Array.from({ length: 10 }, (_, index) =>
      appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [{
        type: "agent.message.delta",
        payload: { text: String(index) },
        producerId: "producer",
        producerSeq: index,
      }])
    ));
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 20);
    expect(events).toHaveLength(10);
    expectContiguousSequences(events);
  });

  test("enforces client and producer idempotency constraints", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "dedupe",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [
      { type: "user.message", payload: { text: "one" }, clientEventId: "same-client" },
      { type: "agent.message.delta", payload: { text: "a" }, producerId: "p", producerSeq: 1 },
    ]);
    await expect(appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [
      { type: "user.message", payload: { text: "two" }, clientEventId: "same-client" },
    ])).rejects.toThrow();
    await expect(appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [
      { type: "agent.message.delta", payload: { text: "b" }, producerId: "p", producerSeq: 1 },
    ])).rejects.toThrow();
  });

  test("persists run state versions and turn status transitions", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "turns",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [
      { type: "user.message", payload: { text: "turns" } },
    ]);
    const turnId = await createTurn(dbClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      temporalWorkflowId: "workflow",
    });
    await saveRunState(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId,
      serializedRunState: "state-1",
      pendingApprovals: [],
    });
    await saveRunState(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId,
      serializedRunState: "state-2",
      pendingApprovals: [{ id: "approval" }],
    });
    const latest = await getLatestRunState(dbClient.db, grant.workspaceId, session.id);
    expect(latest?.serializedRunState).toBe("state-2");
    await finishTurn(dbClient.db, grant.workspaceId, turnId, "idle");
    await setSessionStatus(dbClient.db, grant.workspaceId, session.id, "idle", null);
  });

  test("persists scheduled tasks and run history", async () => {
    const grant = await testGrant(dbClient.db);
    const task = await createScheduledTask(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "daily",
      status: "active",
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      schedule: { type: "interval", everySeconds: 3600 },
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "run",
        resources: [],
        tools: [],
        metadata: {},
      },
      metadata: {},
    });
    const updated = await updateScheduledTask(dbClient.db, grant.workspaceId, task.id, { status: "paused" });
    expect(updated.status).toBe("paused");
    expect((await listScheduledTasks(dbClient.db, grant.workspaceId)).some((item) => item.id === task.id)).toBe(true);

    const run = await createScheduledTaskRun(dbClient.db, {
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "manual",
      scheduledAt: null,
    });
    await updateScheduledTaskRun(dbClient.db, grant.workspaceId, run.id, { status: "failed", error: "no worker" });
    const runs = await listScheduledTaskRuns(dbClient.db, grant.workspaceId, task.id);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.error).toBe("no worker");
  });

  test("RLS policies isolate workspace-owned rows for a non-owner app role", async () => {
    const appRoleUrl = await createRlsAppRole(dbClient.db, services.databaseUrl);
    const appDbClient = createDb(appRoleUrl);
    try {
      const grantA = await testGrant(dbClient.db);
      const grantB = await testGrant(dbClient.db);
      await createSession(dbClient.db, {
        accountId: grantB.accountId,
        workspaceId: grantB.workspaceId,
        initialMessage: "workspace b",
        resources: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });

      const hidden = await appDbClient.db.execute(dbSql<{ count: string }>`select count(*)::text as count from sessions`);
      expect(Number(hidden[0]?.count ?? 0)).toBe(0);

      const created = await createSession(appDbClient.db, {
        accountId: grantA.accountId,
        workspaceId: grantA.workspaceId,
        initialMessage: "workspace a",
        resources: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      expect(created.workspaceId).toBe(grantA.workspaceId);
      expect((await getSession(appDbClient.db, grantA.workspaceId, created.id))?.id).toBe(created.id);

      const visible = await withRlsContext(appDbClient.db, grantA, async (db) =>
        await db.execute(dbSql<{ id: string; workspace_id: string }>`select id, workspace_id::text from sessions order by created_at asc`)
      );
      expect(visible.map((row) => row.workspace_id)).toEqual([grantA.workspaceId]);

      await expect(createSession(appDbClient.db, {
        accountId: grantA.accountId,
        workspaceId: grantB.workspaceId,
        initialMessage: "mismatched account workspace",
        resources: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      })).rejects.toThrow();

      const keyHash = crypto.randomUUID();
      const apiKey = await createApiKey(appDbClient.db, {
        accountId: grantA.accountId,
        workspaceId: grantA.workspaceId,
        name: "RLS key",
        prefix: "og_test",
        keyHash,
        permissions: ["sessions:create"],
      });
      expect((await findActiveApiKeyByHash(appDbClient.db, keyHash))?.id).toBe(apiKey.id);
    } finally {
      await appDbClient.close();
    }
  });
});

async function testGrant(db: ReturnType<typeof createDb>["db"]): Promise<AccessGrant> {
  const id = crypto.randomUUID();
  const context = await bootstrapWorkspace(db, {
    accountExternalSource: "test:db",
    accountExternalId: `account:${id}`,
    accountName: "DB integration account",
    workspaceExternalSource: "test:db",
    workspaceExternalId: `workspace:${id}`,
    workspaceName: "DB integration workspace",
    subjectId: `test:db:${id}`,
    subjectLabel: "DB integration",
  });
  const grant = context.workspaceGrants[0];
  if (!grant) {
    throw new Error("DB test did not create a workspace grant");
  }
  return grant;
}

async function createRlsAppRole(db: ReturnType<typeof createDb>["db"], ownerUrl: string): Promise<string> {
  const role = `opengeni_rls_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const password = `pw_${crypto.randomUUID().replace(/-/g, "")}`;
  await db.execute(dbSql.raw(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`));
  await db.execute(dbSql.raw(`GRANT USAGE ON SCHEMA public TO "${role}"`));
  await db.execute(dbSql.raw(`GRANT USAGE ON SCHEMA opengeni_private TO "${role}"`));
  await db.execute(dbSql.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`));
  await db.execute(dbSql.raw(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO "${role}"`));
  const url = new URL(ownerUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}
