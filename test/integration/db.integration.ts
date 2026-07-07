import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as dbSchema from "../../packages/db/src/schema";
import {
  appendSessionEvents,
  appendSessionHistoryItems,
  applyContextCompaction,
  bootstrapWorkspace,
  claimNextQueuedTurn,
  clearSessionContext,
  consumeSessionCompactionRequest,
  countSessionHistoryItems,
  createKnowledgeMemory,
  getKnowledgeMemory,
  saveWorkspaceMemory,
  correctWorkspaceMemory,
  searchWorkspaceMemories,
  resolveWorkspaceMemoryBlock,
  updateKnowledgeMemory,
  hashMemoryText,
  MEMORY_VISIBLE_RECORD_CAP,
  type MemoryEmbedder,
  createDb,
  decryptEnvironmentValue,
  getActiveSessionHistoryItems,
  getSessionHistoryItems,
  requestSessionCompaction,
  setSessionLastInputTokens,
  createScheduledTask,
  createScheduledTaskRun,
  createApiKey,
  createSession,
  createSessionGoal,
  createSessionWithIdempotencyKey,
  encryptEnvironmentValue,
  getSessionByCreateIdempotencyKey,
  createTurn,
  dbSql,
  enableCapabilityInstallation,
  enqueueSessionTurn,
  evaluateGoalContinuation,
  finishTurn,
  findActiveApiKeyByHash,
  getLatestRunState,
  getSession,
  getSessionGoal,
  setSessionGoalLastContinuationTurn,
  setSessionGoalStatus,
  updateSessionGoal,
  upsertSessionGoal,
  listEnabledMcpCapabilityServers,
  listKnowledgeMemories,
  listSessionMcpServerMetadata,
  listSessionMcpServersForRun,
  listScheduledTaskRuns,
  listScheduledTasks,
  getSessionTurn,
  listSessionEvents,
  requeuePreemptedTurn,
  saveRunState,
  setSessionStatus,
  updateScheduledTask,
  updateScheduledTaskRun,
  updateSessionMcpServerCredentials,
  withRlsContext,
  upsertCapabilityCatalogItem,
} from "@opengeni/db";
import type { AccessGrant, Permission } from "@opengeni/contracts";
import { applyRawSql, expectContiguousSequences, startTestServices, type TestServices } from "@opengeni/testing";

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

  test("stores per-session MCP credentials encrypted and bumps credential version on rotation", async () => {
    const grant = await testGrant(dbClient.db);
    const encryptionKey = new Uint8Array(32);
    encryptionKey.fill(7);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "session mcp",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
      mcpServers: [{
        id: "crm",
        name: "CRM MCP",
        url: "https://crm.example/mcp",
        allowedTools: ["workouts.list"],
        timeoutMs: 2500,
        cacheToolsList: true,
        headersEncrypted: {
          Authorization: encryptEnvironmentValue(encryptionKey, "Bearer create-secret"),
        },
      }],
    });

    expect(session.mcpServers).toEqual([{
      id: "crm",
      name: "CRM MCP",
      url: "https://crm.example/mcp",
      headerNames: ["Authorization"],
      credentialVersion: 1,
    }]);
    expect(await listSessionMcpServerMetadata(dbClient.db, grant.workspaceId, session.id)).toEqual(session.mcpServers);

    const rawRows = await dbClient.db.execute(dbSql<{
      headers_encrypted: Record<string, string>;
      credential_version: number;
    }>`select headers_encrypted, credential_version from session_mcp_servers where session_id = ${session.id}`);
    const raw = rawRows[0]!;
    expect(JSON.stringify(raw.headers_encrypted)).not.toContain("create-secret");
    expect(decryptEnvironmentValue(encryptionKey, raw.headers_encrypted.Authorization!)).toBe("Bearer create-secret");
    expect(Number(raw.credential_version)).toBe(1);

    const forRun = await listSessionMcpServersForRun(dbClient.db, grant.workspaceId, session.id, encryptionKey);
    expect(forRun).toEqual([{
      id: "crm",
      name: "CRM MCP",
      url: "https://crm.example/mcp",
      allowedTools: ["workouts.list"],
      timeoutMs: 2500,
      cacheToolsList: true,
      headerNames: ["Authorization"],
      headers: { Authorization: "Bearer create-secret" },
      credentialVersion: 1,
    }]);

    const rotated = await updateSessionMcpServerCredentials(dbClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      updates: [{
        id: "crm",
        headersEncrypted: {
          Authorization: encryptEnvironmentValue(encryptionKey, "Bearer rotated-secret"),
          "X-Session": encryptEnvironmentValue(encryptionKey, "turn-2"),
        },
      }],
    });
    expect(rotated.missingIds).toEqual([]);
    expect(rotated.servers).toEqual([{
      id: "crm",
      name: "CRM MCP",
      url: "https://crm.example/mcp",
      headerNames: ["Authorization", "X-Session"],
      credentialVersion: 2,
    }]);

    const afterRotation = await listSessionMcpServersForRun(dbClient.db, grant.workspaceId, session.id, encryptionKey);
    expect(afterRotation[0]?.headers).toEqual({ Authorization: "Bearer rotated-secret", "X-Session": "turn-2" });
    expect(afterRotation[0]?.credentialVersion).toBe(2);
    const rawAfterRows = await dbClient.db.execute(dbSql<{
      headers_encrypted: Record<string, string>;
    }>`select headers_encrypted from session_mcp_servers where session_id = ${session.id}`);
    expect(JSON.stringify(rawAfterRows[0]!.headers_encrypted)).not.toContain("rotated-secret");
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

  test("workspace-scoped create idempotency key collapses sequential and concurrent races to one session", async () => {
    const grant = await testGrant(dbClient.db);
    const otherGrant = await testGrant(dbClient.db);
    const countSessions = async (workspaceId: string, key: string): Promise<number> => {
      const rows = await dbClient.db.execute(dbSql<{ n: number }>`select count(*)::int as n from sessions where workspace_id = ${workspaceId} and create_idempotency_key = ${key}`);
      return Number(rows[0]?.n ?? 0);
    };
    const baseInput = (key: string) => ({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "idempotent create",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none" as const,
      createIdempotencyKey: key,
    });

    // 1. Sequential: same key twice -> one row, second is a dup of the first.
    const seqKey = `seq-${crypto.randomUUID()}`;
    const first = await createSessionWithIdempotencyKey(dbClient.db, baseInput(seqKey));
    const second = await createSessionWithIdempotencyKey(dbClient.db, baseInput(seqKey));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.session.id).toBe(first.session.id);
    expect(await countSessions(grant.workspaceId, seqKey)).toBe(1);
    // The lookup helper resolves the same row by key.
    expect((await getSessionByCreateIdempotencyKey(dbClient.db, grant.workspaceId, seqKey))?.id).toBe(first.session.id);

    // 2. Concurrent: N near-simultaneous creates with the same key race the
    //    partial unique index; exactly one wins (created=true), the rest catch
    //    the unique violation and return the winner's row.
    const raceKey = `race-${crypto.randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      createSessionWithIdempotencyKey(dbClient.db, baseInput(raceKey))));
    const winners = results.filter((r) => r.created);
    expect(winners).toHaveLength(1);
    const ids = new Set(results.map((r) => r.session.id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe(winners[0]!.session.id);
    expect(await countSessions(grant.workspaceId, raceKey)).toBe(1);

    // 3a. Different key -> independent create (back-compat).
    const otherKey = `other-${crypto.randomUUID()}`;
    const otherKeyed = await createSessionWithIdempotencyKey(dbClient.db, baseInput(otherKey));
    expect(otherKeyed.created).toBe(true);
    expect(otherKeyed.session.id).not.toBe(first.session.id);

    // 3b. Same key string but a DIFFERENT workspace -> independent create (the
    //     key is workspace-scoped, not global).
    const crossWorkspace = await createSessionWithIdempotencyKey(dbClient.db, {
      accountId: otherGrant.accountId,
      workspaceId: otherGrant.workspaceId,
      initialMessage: "idempotent create",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
      createIdempotencyKey: seqKey,
    });
    expect(crossWorkspace.created).toBe(true);
    expect(crossWorkspace.session.id).not.toBe(first.session.id);

    // 3c. Absent key (the legacy createSession path) -> always independent, and
    //     two key-less creates never collide on the partial index.
    const plainA = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "no key a",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const plainB = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "no key b",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    expect(plainA.id).not.toBe(plainB.id);
    expect(plainA.createIdempotencyKey).toBeNull();
    expect(plainB.createIdempotencyKey).toBeNull();
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

  test("requeues a preempted running turn behind a swapped trigger event", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "long task",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger, resumeTrigger] = await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [
      { type: "user.message", payload: { text: "long task" } },
      { type: "turn.preempted", payload: { reason: "worker_shutdown", text: "resume" } },
    ]);
    const turn = await enqueueSessionTurn(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      temporalWorkflowId: "wf-preempt-db",
      source: "user",
      prompt: "long task",
      resources: [],
      tools: [],
      model: "scripted-model",
      reasoningEffort: "low",
      sandboxBackend: "none",
      metadata: {},
    });
    const claimed = await claimNextQueuedTurn(dbClient.db, grant.workspaceId, session.id, "wf-preempt-db");
    expect(claimed?.id).toBe(turn.id);

    await requeuePreemptedTurn(dbClient.db, grant.workspaceId, turn.id, resumeTrigger!.id);
    const requeued = await getSessionTurn(dbClient.db, grant.workspaceId, turn.id);
    expect(requeued?.status).toBe("queued");
    expect(requeued?.triggerEventId).toBe(resumeTrigger!.id);
    expect(requeued?.startedAt).toBeNull();

    // The next claim re-dispatches the same turn through the resume trigger.
    const reclaimed = await claimNextQueuedTurn(dbClient.db, grant.workspaceId, session.id, "wf-preempt-db-2");
    expect(reclaimed?.id).toBe(turn.id);
    expect(reclaimed?.triggerEventId).toBe(resumeTrigger!.id);

    // An approval rerun re-dispatches the same turn without a fresh claim, so
    // a shutdown there preempts a turn still marked requires_action.
    await finishTurn(dbClient.db, grant.workspaceId, turn.id, "requires_action");
    await requeuePreemptedTurn(dbClient.db, grant.workspaceId, turn.id, trigger!.id);
    const requeuedFromApproval = await getSessionTurn(dbClient.db, grant.workspaceId, turn.id);
    expect(requeuedFromApproval?.status).toBe("queued");
    expect(requeuedFromApproval?.triggerEventId).toBe(trigger!.id);

    // Terminal turns cannot be preempt-requeued.
    await finishTurn(dbClient.db, grant.workspaceId, turn.id, "idle");
    await expect(requeuePreemptedTurn(dbClient.db, grant.workspaceId, turn.id, resumeTrigger!.id)).rejects.toThrow("Preemptible session turn not found");
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

  test("session goal lifecycle: set, revise, complete, replace", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "goal lifecycle",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    expect(await getSessionGoal(dbClient.db, grant.workspaceId, session.id)).toBeNull();
    const created = await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "ship the deploy pipeline",
      successCriteria: "CI green on main",
      createdBy: "api",
    });
    expect(created.status).toBe("active");
    expect(created.version).toBe(1);

    const revised = await updateSessionGoal(dbClient.db, grant.workspaceId, session.id, { text: "ship the deploy pipeline v2" });
    expect(revised.version).toBe(2);
    expect(revised.status).toBe("active");

    const paused = await setSessionGoalStatus(dbClient.db, grant.workspaceId, session.id, { status: "paused", rationale: "blocked", pausedReason: "agent" });
    expect(paused.changed).toBe(true);
    expect(paused.goal.pausedReason).toBe("agent");
    const pausedAgain = await setSessionGoalStatus(dbClient.db, grant.workspaceId, session.id, { status: "paused", pausedReason: "agent" });
    expect(pausedAgain.changed).toBe(false);

    const resumed = await setSessionGoalStatus(dbClient.db, grant.workspaceId, session.id, { status: "active" });
    expect(resumed.goal.pausedReason).toBeNull();
    expect(resumed.goal.rationale).toBeNull();
    expect(resumed.goal.autoContinuations).toBe(0);

    const completed = await setSessionGoalStatus(dbClient.db, grant.workspaceId, session.id, { status: "completed", evidence: "pipeline live, CI green" });
    expect(completed.goal.evidence).toBe("pipeline live, CI green");
    await expect(setSessionGoalStatus(dbClient.db, grant.workspaceId, session.id, { status: "active" })).rejects.toThrow("completed");

    const replaced = await upsertSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "now keep it healthy",
      createdBy: "agent",
    });
    expect(replaced.replaced).toBe(true);
    expect(replaced.goal.status).toBe("active");
    expect(replaced.goal.evidence).toBeNull();
    expect(replaced.goal.autoContinuations).toBe(0);
    expect(replaced.goal.version).toBeGreaterThan(completed.goal.version);
  });

  test("evaluateGoalContinuation honors queue, approvals, progress, and caps", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "goal loop",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const guards = { defaultMaxAutoContinuations: 5, noProgressLimit: 2 };
    const enqueueGoalTurn = async () => {
      const [goalTrigger] = await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [{ type: "goal.continuation", payload: { text: "continue" } }]);
      return await enqueueSessionTurn(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: goalTrigger!.id,
        temporalWorkflowId: "wf-goal-db",
        source: "goal",
        prompt: "continue",
        resources: [],
        tools: [],
        model: "scripted-model",
        reasoningEffort: "low",
        sandboxBackend: "none",
        metadata: {},
      });
    };

    // No goal yet.
    expect(await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards })).toEqual({ decision: "none" });

    await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "keep working",
      createdBy: "api",
    });

    // Queued work always wins.
    const [trigger] = await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [{ type: "user.message", payload: { text: "go" } }]);
    const queuedUserTurn = await enqueueSessionTurn(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      temporalWorkflowId: "wf-goal-db",
      source: "user",
      prompt: "go",
      resources: [],
      tools: [],
      model: "scripted-model",
      reasoningEffort: "low",
      sandboxBackend: "none",
      metadata: {},
    });
    expect((await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards })).decision).toBe("queue");

    // A non-terminal requires_action turn (pending approval) blocks continuation.
    await finishTurn(dbClient.db, grant.workspaceId, queuedUserTurn.id, "requires_action");
    expect((await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards })).decision).toBe("none");
    await finishTurn(dbClient.db, grant.workspaceId, queuedUserTurn.id, "completed");

    // First continuation.
    const first = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
    expect(first).toMatchObject({ decision: "continue", autoContinuation: 1, cap: 5 });

    // A continuation turn that finishes without tool calls or a goal revision
    // increments the no-progress streak; noProgressLimit 2 pauses the goal.
    for (let round = 1; round <= 2; round += 1) {
      const continuationTurn = await enqueueGoalTurn();
      await setSessionGoalLastContinuationTurn(dbClient.db, grant.workspaceId, session.id, continuationTurn.id);
      await finishTurn(dbClient.db, grant.workspaceId, continuationTurn.id, "completed");
      const next = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
      if (round < 2) {
        expect(next.decision).toBe("continue");
      } else {
        expect(next).toMatchObject({ decision: "paused", reason: "no_progress" });
      }
    }
    expect((await getSessionGoal(dbClient.db, grant.workspaceId, session.id))?.pausedReason).toBe("no_progress");

    // Replacing the goal re-arms it; the per-goal cap is enforced.
    await upsertSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "one more push",
      maxAutoContinuations: 1,
      createdBy: "agent",
    });
    const capped = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
    expect(capped).toMatchObject({ decision: "continue", autoContinuation: 1, cap: 1 });
    // Mark progress in that continuation so the cap (not no-progress) triggers.
    const capTurn = await enqueueGoalTurn();
    await setSessionGoalLastContinuationTurn(dbClient.db, grant.workspaceId, session.id, capTurn.id);
    await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [{ type: "agent.toolCall.created", turnId: capTurn.id, payload: {} }]);
    await finishTurn(dbClient.db, grant.workspaceId, capTurn.id, "completed");
    const atCap = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
    expect(atCap).toMatchObject({ decision: "paused", reason: "max_auto_continuations" });
  });

  test("provider backpressure turns freeze the no-progress streak", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "goal loop",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const guards = { defaultMaxAutoContinuations: 10, noProgressLimit: 2 };
    const enqueueGoalTurn = async () => {
      const [goalTrigger] = await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [{ type: "goal.continuation", payload: { text: "continue" } }]);
      return await enqueueSessionTurn(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: goalTrigger!.id,
        temporalWorkflowId: "wf-goal-backpressure",
        source: "goal",
        prompt: "continue",
        resources: [],
        tools: [],
        model: "scripted-model",
        reasoningEffort: "low",
        sandboxBackend: "none",
        metadata: {},
      });
    };
    await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "outlast the rate limiter",
      createdBy: "api",
    });
    const first = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
    expect(first).toMatchObject({ decision: "continue", autoContinuation: 1 });

    // Three consecutive rate-limited continuations (no tool calls) exceed
    // noProgressLimit 2, but backpressure failures must not advance the
    // streak: the goal keeps continuing instead of pausing as no_progress.
    for (let round = 1; round <= 3; round += 1) {
      const turn = await enqueueGoalTurn();
      await setSessionGoalLastContinuationTurn(dbClient.db, grant.workspaceId, session.id, turn.id);
      await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [{
        type: "turn.failed",
        turnId: turn.id,
        payload: { code: "provider_rate_limited", retryable: true, recovery: "goal_continuation", runStateSaved: false },
      }]);
      await finishTurn(dbClient.db, grant.workspaceId, turn.id, "failed");
      const next = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
      expect(next).toMatchObject({ decision: "continue", autoContinuation: 1 + round });
    }

    // Ordinary empty continuations still count: two of them pause the goal.
    for (let round = 1; round <= 2; round += 1) {
      const turn = await enqueueGoalTurn();
      await setSessionGoalLastContinuationTurn(dbClient.db, grant.workspaceId, session.id, turn.id);
      await finishTurn(dbClient.db, grant.workspaceId, turn.id, "completed");
      const next = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
      if (round < 2) {
        expect(next.decision).toBe("continue");
      } else {
        expect(next).toMatchObject({ decision: "paused", reason: "no_progress" });
      }
    }
  });

  test("goals are uncapped by count when no default cap is configured", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "multi-day goal",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    // No deployment default: length is governed by progress/budget guards only.
    const guards = { defaultMaxAutoContinuations: null, noProgressLimit: 2 };
    const enqueueGoalTurn = async () => {
      const [goalTrigger] = await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [{ type: "goal.continuation", payload: { text: "continue" } }]);
      return await enqueueSessionTurn(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: goalTrigger!.id,
        temporalWorkflowId: "wf-goal-uncapped",
        source: "goal",
        prompt: "continue",
        resources: [],
        tools: [],
        model: "scripted-model",
        reasoningEffort: "low",
        sandboxBackend: "none",
        metadata: {},
      });
    };
    await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "keep going for days",
      createdBy: "api",
    });
    // Run well past the old default cap of 20; with progress every round the
    // loop must keep continuing, with a null cap throughout.
    let decision = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
    expect(decision).toMatchObject({ decision: "continue", autoContinuation: 1, cap: null });
    for (let round = 2; round <= 25; round += 1) {
      const turn = await enqueueGoalTurn();
      await setSessionGoalLastContinuationTurn(dbClient.db, grant.workspaceId, session.id, turn.id);
      await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [{ type: "agent.toolCall.created", turnId: turn.id, payload: {} }]);
      await finishTurn(dbClient.db, grant.workspaceId, turn.id, "completed");
      decision = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
      expect(decision).toMatchObject({ decision: "continue", autoContinuation: round, cap: null });
    }
    // A per-goal cap still applies on its own, without any deployment default.
    await upsertSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "bounded push",
      maxAutoContinuations: 1,
      createdBy: "agent",
    });
    const bounded = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
    expect(bounded).toMatchObject({ decision: "continue", autoContinuation: 1, cap: 1 });
    const boundedTurn = await enqueueGoalTurn();
    await setSessionGoalLastContinuationTurn(dbClient.db, grant.workspaceId, session.id, boundedTurn.id);
    await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [{ type: "agent.toolCall.created", turnId: boundedTurn.id, payload: {} }]);
    await finishTurn(dbClient.db, grant.workspaceId, boundedTurn.id, "completed");
    const atCap = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
    expect(atCap).toMatchObject({ decision: "paused", reason: "max_auto_continuations" });
  });

  test("migration backfills goals:manage into goal-bearing sessions with explicit first-party permissions", async () => {
    const migrationName = "0009_goal_sessions_first_party_goals_manage.sql";
    const grant = await testGrant(dbClient.db);
    const makeSession = async (firstPartyMcpPermissions: Permission[] | null) => await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "backfill fixture",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
      firstPartyMcpPermissions,
    });
    const addGoal = async (sessionId: string) => await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId,
      text: "stay green",
      createdBy: "api",
    });

    // Healed: explicit permissions missing goals:manage + a non-completed goal.
    const activeGoalSession = await makeSession(["workspace:read", "github:use"]);
    await addGoal(activeGoalSession.id);
    const pausedGoalSession = await makeSession(["workspace:read"]);
    await addGoal(pausedGoalSession.id);
    await setSessionGoalStatus(dbClient.db, grant.workspaceId, pausedGoalSession.id, { status: "paused", pausedReason: "operator hold" });
    // Untouched: completed goal, no goal, already-holding, and default (null) sets.
    const completedGoalSession = await makeSession(["workspace:read"]);
    await addGoal(completedGoalSession.id);
    await setSessionGoalStatus(dbClient.db, grant.workspaceId, completedGoalSession.id, { status: "completed", evidence: "done" });
    const noGoalSession = await makeSession(["workspace:read"]);
    const alreadyHoldingSession = await makeSession(["goals:manage", "workspace:read"]);
    await addGoal(alreadyHoldingSession.id);
    const defaultSetSession = await makeSession(null);
    await addGoal(defaultSetSession.id);

    // The fixture rows were created after beforeAll already applied the
    // migration, so un-record it and run the migration path again - the same
    // way an upgraded deployment replays pending files over existing data.
    const rerunMigration = async () => {
      await dbClient.db.execute(dbSql`DELETE FROM "schema_migrations" WHERE "name" = ${migrationName}`);
      await services.migrate();
    };
    await rerunMigration();

    const permissionsOf = async (sessionId: string) =>
      (await getSession(dbClient.db, grant.workspaceId, sessionId))?.firstPartyMcpPermissions ?? null;
    expect(await permissionsOf(activeGoalSession.id)).toEqual(["workspace:read", "github:use", "goals:manage"] as Permission[]);
    expect(await permissionsOf(pausedGoalSession.id)).toEqual(["workspace:read", "goals:manage"] as Permission[]);
    expect(await permissionsOf(completedGoalSession.id)).toEqual(["workspace:read"] as Permission[]);
    expect(await permissionsOf(noGoalSession.id)).toEqual(["workspace:read"] as Permission[]);
    expect(await permissionsOf(alreadyHoldingSession.id)).toEqual(["goals:manage", "workspace:read"] as Permission[]);
    expect(await permissionsOf(defaultSetSession.id)).toBeNull();

    // Idempotent: a second run adds nothing.
    await rerunMigration();
    expect(await permissionsOf(activeGoalSession.id)).toEqual(["workspace:read", "github:use", "goals:manage"] as Permission[]);
    expect(await permissionsOf(alreadyHoldingSession.id)).toEqual(["goals:manage", "workspace:read"] as Permission[]);
  });

  test("RLS policies isolate session goal rows for a non-owner app role", async () => {
    const appRoleUrl = await createRlsAppRole(dbClient.db, services.databaseUrl);
    const appDbClient = createDb(appRoleUrl);
    try {
      const grantA = await testGrant(dbClient.db);
      const grantB = await testGrant(dbClient.db);
      const sessionB = await createSession(dbClient.db, {
        accountId: grantB.accountId,
        workspaceId: grantB.workspaceId,
        initialMessage: "workspace b goal",
        resources: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      await createSessionGoal(dbClient.db, {
        accountId: grantB.accountId,
        workspaceId: grantB.workspaceId,
        sessionId: sessionB.id,
        text: "workspace b objective",
        createdBy: "api",
      });

      const hidden = await appDbClient.db.execute(dbSql<{ count: string }>`select count(*)::text as count from session_goals`);
      expect(Number(hidden[0]?.count ?? 0)).toBe(0);

      const sessionA = await createSession(appDbClient.db, {
        accountId: grantA.accountId,
        workspaceId: grantA.workspaceId,
        initialMessage: "workspace a goal",
        resources: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      await createSessionGoal(appDbClient.db, {
        accountId: grantA.accountId,
        workspaceId: grantA.workspaceId,
        sessionId: sessionA.id,
        text: "workspace a objective",
        createdBy: "api",
      });
      const visible = await withRlsContext(appDbClient.db, grantA, async (db) =>
        await db.execute(dbSql<{ workspace_id: string }>`select workspace_id::text from session_goals`)
      );
      expect(visible.map((row) => row.workspace_id)).toEqual([grantA.workspaceId]);

      await expect(withRlsContext(appDbClient.db, grantA, async (db) => {
        await db.execute(dbSql`
          insert into session_goals (account_id, workspace_id, session_id, text)
          values (${grantA.accountId}, ${grantB.workspaceId}, ${sessionB.id}, 'mismatched goal')
        `);
      })).rejects.toThrow();
    } finally {
      await appDbClient.close();
    }
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

  test("RLS policies isolate knowledge memories for a non-owner app role", async () => {
    const appRoleUrl = await createRlsAppRole(dbClient.db, services.databaseUrl);
    const appDbClient = createDb(appRoleUrl);
    try {
      const grantA = await testGrant(dbClient.db);
      const grantB = await testGrant(dbClient.db);
      await createKnowledgeMemory(dbClient.db, {
        accountId: grantB.accountId,
        workspaceId: grantB.workspaceId,
        status: "approved",
        kind: "decision",
        text: "Workspace B private decision",
      });

      const hidden = await appDbClient.db.execute(dbSql<{ count: string }>`select count(*)::text as count from knowledge_memories`);
      expect(Number(hidden[0]?.count ?? 0)).toBe(0);

      const created = await createKnowledgeMemory(appDbClient.db, {
        accountId: grantA.accountId,
        workspaceId: grantA.workspaceId,
        kind: "semantic",
        text: "Workspace A reviewed context",
      });
      expect(created.workspaceId).toBe(grantA.workspaceId);

      const visible = await listKnowledgeMemories(appDbClient.db, grantA.workspaceId);
      expect(visible.map((memory) => memory.workspaceId)).toEqual([grantA.workspaceId]);

      await expect(createKnowledgeMemory(appDbClient.db, {
        accountId: grantA.accountId,
        workspaceId: grantB.workspaceId,
        text: "Mismatched memory",
      })).rejects.toThrow();
    } finally {
      await appDbClient.close();
    }
  });

  // ---- Workspace Memory V1 (M1) -------------------------------------------

  // Deterministic per-text 3072-d vector (same text → same vector), enough to
  // exercise the vector arm without pulling @opengeni/documents into the harness.
  const deterministicVector = (text: string): number[] => {
    const vec = new Array<number>(3072);
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    for (let i = 0; i < 3072; i += 1) {
      h ^= i + 1;
      h = Math.imul(h, 16777619) >>> 0;
      vec[i] = ((h >>> 0) / 4294967295) * 2 - 1;
    }
    return vec;
  };
  const memoryEmbedder: MemoryEmbedder = {
    model: "test-deterministic-3072",
    embedMany: async (texts: string[]) => texts.map(deterministicVector),
  };
  const enableWorkspaceMemory = async (workspaceId: string) => {
    await dbClient.db.execute(dbSql`update workspaces set settings = '{"memoryEnabled":true}'::jsonb where id = ${workspaceId}`);
  };
  // Every text embeds to the SAME non-zero vector → any two distinct texts are
  // cosine-identical, which exercises the near-dup gate (distinct hash, sim = 1).
  const collidingEmbedder = (model: string): MemoryEmbedder => {
    const fixed = new Array(3072).fill(0.0125);
    return { model, embedMany: async (texts: string[]) => texts.map(() => fixed) };
  };
  const throwingEmbedder: MemoryEmbedder = {
    model: "throwing-embedder",
    embedMany: async () => { throw new Error("embedder unavailable"); },
  };

  test("AC-3/AC-5/AC-6: save embeds, hybrid search finds it, and usage counters bump", async () => {
    const grant = await testGrant(dbClient.db);
    const saved = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      text: "Staging deploys from main only, via the opengeni-ops workflow.",
      kind: "procedural",
    }, memoryEmbedder);
    expect(saved.deduped).toBe(false);
    expect(saved.embedded).toBe(true);
    expect(saved.memory.status).toBe("active");
    expect(saved.memory.usageCount).toBe(0);

    const hits = await searchWorkspaceMemories(dbClient.db, grant.workspaceId, { query: "how do we deploy staging" }, memoryEmbedder);
    expect(hits.map((hit) => hit.memory.id)).toContain(saved.memory.id);
    const hit = hits.find((entry) => entry.memory.id === saved.memory.id)!;
    expect(hit.score).toBeGreaterThan(0);
    // usage_count bumped exactly once for the returned row; updated_at untouched.
    expect(hit.memory.usageCount).toBe(1);
    expect(hit.memory.lastUsedAt).not.toBeNull();
    expect(hit.memory.updatedAt).toBe(saved.memory.updatedAt);
  });

  test("AC-3: exact-duplicate save is a NOOP returning the existing id", async () => {
    const grant = await testGrant(dbClient.db);
    const first = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId, text: "Prefer Terraform over Pulumi.",
    }, memoryEmbedder);
    const again = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId, text: "  prefer   TERRAFORM over pulumi.  ",
    }, memoryEmbedder);
    expect(again.deduped).toBe(true);
    expect(again.dedupeReason).toBe("exact");
    expect(again.memory.id).toBe(first.memory.id);
    const all = await listKnowledgeMemories(dbClient.db, grant.workspaceId, { kind: "semantic" });
    expect(all.filter((memory) => memory.status === "active")).toHaveLength(1);
  });

  test("concurrent exact-duplicate saves converge on one visible row", async () => {
    const grant = await testGrant(dbClient.db);
    const text = "Concurrent saves normalize to one exact memory.";
    const [first, second] = await Promise.all([
      saveWorkspaceMemory(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text,
      }, memoryEmbedder),
      saveWorkspaceMemory(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: " concurrent   SAVES normalize to one exact memory. ",
      }, memoryEmbedder),
    ]);

    expect(new Set([first.memory.id, second.memory.id]).size).toBe(1);
    expect([first.deduped, second.deduped].filter(Boolean)).toHaveLength(1);
    const [{ visibleCount } = { visibleCount: 0 }] = await dbClient.db.execute<{ visibleCount: number }>(dbSql`
      select count(*)::int as "visibleCount" from knowledge_memories
      where workspace_id = ${grant.workspaceId}::uuid
        and status in ('active', 'approved')
        and text_hash = ${hashMemoryText(text)}
    `);
    expect(Number(visibleCount)).toBe(1);
  });

  test("activating a proposed memory that exact-dups a visible row fails actionably", async () => {
    const grant = await testGrant(dbClient.db);
    const active = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      text: "Production incidents page the SRE rotation.",
    }, memoryEmbedder);
    const proposed = await createKnowledgeMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      status: "proposed",
      text: " production   INCIDENTS page the SRE rotation. ",
    });

    await expect(updateKnowledgeMemory(dbClient.db, grant.workspaceId, proposed.id, {
      status: "active",
    }, memoryEmbedder)).rejects.toThrow(new RegExp(`duplicates an existing visible memory.*${active.memory.id}`));
  });

  test("exact-duplicate save ignores proposed rows the agent cannot see", async () => {
    const grant = await testGrant(dbClient.db);
    const text = "Use staged rollout windows for risky API changes.";
    const [proposed] = await dbClient.db.insert(dbSchema.knowledgeMemories).values({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      status: "proposed",
      kind: "semantic",
      scope: "workspace",
      text,
      textHash: hashMemoryText(text),
    }).returning({ id: dbSchema.knowledgeMemories.id });
    const saved = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      text: " use   STAGED rollout windows for risky API changes. ",
    }, memoryEmbedder);
    expect(saved.deduped).toBe(false);
    expect(saved.memory.status).toBe("active");
    expect(saved.memory.id).not.toBe(proposed?.id);
  });

  test("exact-duplicate save dedupes against approved curated memory", async () => {
    const grant = await testGrant(dbClient.db);
    const curated = await createKnowledgeMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      status: "approved",
      kind: "semantic",
      text: "Production deploys require a release manager approval.",
    });
    const saved = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      text: " production  deploys REQUIRE a release manager approval. ",
    }, memoryEmbedder);
    expect(saved.deduped).toBe(true);
    expect(saved.dedupeReason).toBe("exact");
    expect(saved.memory.id).toBe(curated.id);
  });

  test("AC-3: near-duplicate (cosine >= threshold) save is a NOOP", async () => {
    const grant = await testGrant(dbClient.db);
    const embedder = collidingEmbedder("colliding-model-3072");
    const first = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId, text: "The primary database lives in West Europe.",
    }, embedder);
    const near = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId, text: "Totally different words but identical embedding.",
    }, embedder);
    expect(near.deduped).toBe(true);
    expect(near.dedupeReason).toBe("near");
    expect(near.memory.id).toBe(first.memory.id);
  });

  test("AC-3: over-length and empty text are rejected actionably", async () => {
    const grant = await testGrant(dbClient.db);
    await expect(saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId, text: "x".repeat(5000),
    }, memoryEmbedder)).rejects.toThrow(/too long/i);
    await expect(saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId, text: "   \n\t  ",
    }, memoryEmbedder)).rejects.toThrow(/empty/i);
  });

  test("AC-3: secrets are redacted in the stored row", async () => {
    const grant = await testGrant(dbClient.db);
    const saved = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId,
      text: "deploy uses AKIAIOSFODNN7EXAMPLE and a -----BEGIN RSA PRIVATE KEY-----\nMIIsecret\n-----END RSA PRIVATE KEY-----",
    }, memoryEmbedder);
    expect(saved.redactionCount).toBeGreaterThanOrEqual(2);
    expect(saved.memory.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(saved.memory.text).not.toContain("MIIsecret");
    expect(saved.memory.text).toContain("[REDACTED]");
  });

  test("AC-4: replaces_id supersedes the old record and links both ways", async () => {
    const grant = await testGrant(dbClient.db);
    const old = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId, text: "Staging runs on the gecko cluster.", kind: "semantic",
    }, memoryEmbedder);
    const next = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId,
      text: "Staging runs on the neu cluster now.", kind: "semantic", replacesId: old.memory.id,
    }, memoryEmbedder);
    expect(next.superseded?.id).toBe(old.memory.id);
    expect(next.superseded?.status).toBe("superseded");
    expect(next.superseded?.supersededById).toBe(next.memory.id);
    expect(next.superseded?.validUntil).not.toBeNull();
    expect(next.memory.supersedesId).toBe(old.memory.id);
    // Superseded records never appear in search or the working set.
    const hits = await searchWorkspaceMemories(dbClient.db, grant.workspaceId, { query: "staging cluster" }, memoryEmbedder);
    expect(hits.map((hit) => hit.memory.id)).not.toContain(old.memory.id);
  });

  test("AC-4: replaces_id accepts a short id and rejects an unknown id", async () => {
    const grant = await testGrant(dbClient.db);
    const old = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId, text: "Old fact to be replaced by short id.",
    }, memoryEmbedder);
    const next = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId,
      text: "New fact via short id replacement.", replacesId: old.memory.id.slice(0, 8),
    }, memoryEmbedder);
    expect(next.superseded?.id).toBe(old.memory.id);
    await expect(saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId, text: "Points at nothing.", replacesId: "ffffffff",
    }, memoryEmbedder)).rejects.toThrow(/does not match/i);
  });

  test("short memory id resolution ignores terminal rows but remains ambiguous across live rows", async () => {
    const grant = await testGrant(dbClient.db);
    const activeId = "abcddcba-0000-4000-8000-000000000001";
    const archivedId = "abcddcba-0000-4000-8000-000000000002";
    await dbClient.db.insert(dbSchema.knowledgeMemories).values([
      {
        id: activeId,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        status: "active",
        kind: "semantic",
        scope: "workspace",
        text: "Active row with a colliding short id.",
        textHash: hashMemoryText("Active row with a colliding short id."),
      },
      {
        id: archivedId,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        status: "archived",
        kind: "semantic",
        scope: "workspace",
        text: "Archived row with the same short id.",
        textHash: hashMemoryText("Archived row with the same short id."),
      },
    ]);

    const archived = await correctWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      id: activeId.slice(0, 8),
      reason: "terminal collision should not block the live row",
    }, memoryEmbedder);
    expect(archived.action).toBe("archived");
    expect(archived.memory.id).toBe(activeId);
    expect(await getKnowledgeMemory(dbClient.db, grant.workspaceId, archivedId)).toMatchObject({ status: "archived" });

    const ambiguous = await testGrant(dbClient.db);
    const firstLiveId = "feedcafe-0000-4000-8000-000000000001";
    const secondLiveId = "feedcafe-0000-4000-8000-000000000002";
    await dbClient.db.insert(dbSchema.knowledgeMemories).values([
      {
        id: firstLiveId,
        accountId: ambiguous.accountId,
        workspaceId: ambiguous.workspaceId,
        status: "active",
        kind: "semantic",
        scope: "workspace",
        text: "First live row with a colliding short id.",
        textHash: hashMemoryText("First live row with a colliding short id."),
      },
      {
        id: secondLiveId,
        accountId: ambiguous.accountId,
        workspaceId: ambiguous.workspaceId,
        status: "approved",
        kind: "semantic",
        scope: "workspace",
        text: "Second live row with a colliding short id.",
        textHash: hashMemoryText("Second live row with a colliding short id."),
      },
    ]);
    await expect(correctWorkspaceMemory(dbClient.db, {
      accountId: ambiguous.accountId,
      workspaceId: ambiguous.workspaceId,
      id: firstLiveId.slice(0, 8),
      reason: "still ambiguous across live rows",
    }, memoryEmbedder)).rejects.toThrow(/memory_search.*full id/i);
  });

  test("AC-4: correct without replacement archives; with replacement supersedes", async () => {
    const grant = await testGrant(dbClient.db);
    const a = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId, text: "A memory to archive.",
    }, memoryEmbedder);
    const archived = await correctWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId, id: a.memory.id, reason: "no longer true",
    }, memoryEmbedder);
    expect(archived.action).toBe("archived");
    expect(archived.memory.status).toBe("archived");
    expect(archived.replacement).toBeNull();

    const b = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId, text: "A memory to be corrected.", kind: "decision",
    }, memoryEmbedder);
    const corrected = await correctWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId, id: b.memory.id, replacementText: "The corrected decision.",
    }, memoryEmbedder);
    expect(corrected.action).toBe("superseded");
    expect(corrected.memory.id).toBe(b.memory.id);
    expect(corrected.memory.status).toBe("superseded");
    expect(corrected.replacement?.text).toBe("The corrected decision.");
    // Correction inherits the old record's kind.
    expect(corrected.replacement?.kind).toBe("decision");
  });

  test("replacing with text that exact-dedups another live row retires the old row", async () => {
    const grant = await testGrant(dbClient.db);
    const existing = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      text: "Staging deploys from main only.",
      kind: "procedural",
    }, memoryEmbedder);
    const old = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      text: "Staging deploys from develop.",
      kind: "procedural",
    }, memoryEmbedder);

    const corrected = await correctWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      id: old.memory.id,
      replacementText: "  staging   deploys FROM main only. ",
    }, memoryEmbedder);

    expect(corrected.action).toBe("superseded");
    expect(corrected.memory.id).toBe(old.memory.id);
    expect(corrected.memory.status).toBe("superseded");
    expect(corrected.memory.supersededById).toBe(existing.memory.id);
    expect(corrected.replacement?.id).toBe(existing.memory.id);
    expect(corrected.replacement?.status).toBe("active");
    expect(await getKnowledgeMemory(dbClient.db, grant.workspaceId, old.memory.id)).toMatchObject({
      status: "superseded",
      supersededById: existing.memory.id,
    });
  });

  test("replacing with text that near-dedups another live row retires the old row", async () => {
    const grant = await testGrant(dbClient.db);
    const embedder = collidingEmbedder("near-replacement-model-3072");
    const existing = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      text: "Production database failover uses the west-europe replica.",
      kind: "semantic",
    }, embedder);
    const old = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      text: "Production database failover uses the north-europe replica.",
      kind: "semantic",
    });

    const corrected = await correctWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      id: old.memory.id,
      replacementText: "Different words that collide with the existing vector.",
    }, embedder);

    expect(corrected.action).toBe("superseded");
    expect(corrected.memory.id).toBe(old.memory.id);
    expect(corrected.memory.supersededById).toBe(existing.memory.id);
    expect(corrected.replacement?.id).toBe(existing.memory.id);
    expect(await getKnowledgeMemory(dbClient.db, grant.workspaceId, old.memory.id)).toMatchObject({
      status: "superseded",
      supersededById: existing.memory.id,
    });
  });

  test("replacing with text that only dedups the replaces_id row updates that row in place", async () => {
    const grant = await testGrant(dbClient.db);
    const old = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      text: "Prefer Azure OpenAI for default embeddings.",
      kind: "preference",
    }, memoryEmbedder);

    const corrected = await correctWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      id: old.memory.id,
      replacementText: "  prefer   AZURE OpenAI for default embeddings. ",
    }, memoryEmbedder);

    expect(corrected.action).toBe("updated");
    expect(corrected.memory.id).toBe(old.memory.id);
    expect(corrected.memory.status).toBe("active");
    expect(corrected.memory.text).toBe("prefer AZURE OpenAI for default embeddings.");
    expect(corrected.memory.supersededById).toBeNull();
    expect(corrected.replacement).toBeNull();
    expect(await getKnowledgeMemory(dbClient.db, grant.workspaceId, old.memory.id)).toMatchObject({
      status: "active",
      text: "prefer AZURE OpenAI for default embeddings.",
      supersededById: null,
    });
  });

  test("in-place replaces_id update preserves embedding when normalized text is unchanged and applies metadata", async () => {
    const grant = await testGrant(dbClient.db);
    const old = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      text: "Prefer Azure OpenAI for default embeddings.",
      kind: "preference",
    }, memoryEmbedder);
    const [before] = await dbClient.db.execute<{ embeddingText: string | null; embeddingModel: string | null }>(dbSql`
      select embedding::text as "embeddingText", embedding_model as "embeddingModel"
      from knowledge_memories
      where id = ${old.memory.id}
    `);
    expect(before?.embeddingText).toBeTruthy();
    expect(before?.embeddingModel).toBe("test-deterministic-3072");

    const updated = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      text: "  prefer   AZURE OpenAI for default embeddings. ",
      replacesId: old.memory.id,
      kind: "decision",
      confidence: 0.84,
      pinned: true,
    }, throwingEmbedder);

    expect(updated.updated).toBe(true);
    expect(updated.memory.id).toBe(old.memory.id);
    expect(updated.memory.kind).toBe("decision");
    expect(updated.memory.confidence).toBe(0.84);
    expect(updated.memory.pinned).toBe(true);
    const [after] = await dbClient.db.execute<{ embeddingText: string | null; embeddingModel: string | null }>(dbSql`
      select embedding::text as "embeddingText", embedding_model as "embeddingModel"
      from knowledge_memories
      where id = ${old.memory.id}
    `);
    expect(after?.embeddingText).toBe(before?.embeddingText);
    expect(after?.embeddingModel).toBe(before?.embeddingModel);
  });

  test("in-place replaces_id update stamps origin only when metadata has none", async () => {
    const grant = await testGrant(dbClient.db);
    const old = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      text: "Keep existing origin metadata on self-match updates.",
    }, memoryEmbedder);
    expect(old.memory.metadata.origin).toBeUndefined();

    const stamped = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      text: " keep existing ORIGIN metadata on self-match updates. ",
      replacesId: old.memory.id,
      origin: "agent",
    }, memoryEmbedder);
    expect(stamped.memory.id).toBe(old.memory.id);
    expect(stamped.memory.metadata.origin).toBe("agent");

    const preserved = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      text: "Keep existing origin metadata on self-match updates.",
      replacesId: old.memory.id,
      origin: "human",
    }, memoryEmbedder);
    expect(preserved.memory.id).toBe(old.memory.id);
    expect(preserved.memory.metadata.origin).toBe("agent");
  });

  test("in-place replaces_id update clears stale embedding when text changes and embedding fails", async () => {
    const grant = await testGrant(dbClient.db);
    const old = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      text: "The deployment runbook lives in Confluence.",
    }, memoryEmbedder);
    const changedText = "The deployment runbook lives in Notion.";
    // Force an exact self-match while the stored text still differs, exercising
    // the in-place branch's stale-vector handling with a failing embedder.
    await dbClient.db.execute(dbSql`
      update knowledge_memories
      set text_hash = ${hashMemoryText(changedText)}
      where id = ${old.memory.id}
    `);

    const updated = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      text: changedText,
      replacesId: old.memory.id,
    }, throwingEmbedder);

    expect(updated.updated).toBe(true);
    expect(updated.memory.id).toBe(old.memory.id);
    expect(updated.memory.text).toBe(changedText);
    const [row] = await dbClient.db.execute<{ embeddingText: string | null; embeddingModel: string | null }>(dbSql`
      select embedding::text as "embeddingText", embedding_model as "embeddingModel"
      from knowledge_memories
      where id = ${old.memory.id}
    `);
    // The old vector described the Confluence text; after a failed embed for
    // the Notion text it must be cleared so vector search cannot hit stale meaning.
    expect(row?.embeddingText).toBeNull();
    expect(row?.embeddingModel).toBeNull();
  });

  test("AC-5: keyword fallback works when the embedder throws", async () => {
    const grant = await testGrant(dbClient.db);
    const saved = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId, text: "The incident runbook lives in Notion under Operations.",
    }, memoryEmbedder);
    const hits = await searchWorkspaceMemories(dbClient.db, grant.workspaceId, { query: "incident runbook" }, throwingEmbedder);
    expect(hits.map((hit) => hit.memory.id)).toContain(saved.memory.id);
    expect(hits.find((hit) => hit.memory.id === saved.memory.id)?.matchType).toBe("keyword");
  });

  test("AC-2: RLS isolates memory save/search/correct across workspaces", async () => {
    const grantA = await testGrant(dbClient.db);
    const grantB = await testGrant(dbClient.db);
    const inA = await saveWorkspaceMemory(dbClient.db, {
      accountId: grantA.accountId, workspaceId: grantA.workspaceId, text: "Workspace A only secret plan.",
    }, memoryEmbedder);
    // Search scoped to B never sees A's row.
    const bHits = await searchWorkspaceMemories(dbClient.db, grantB.workspaceId, { query: "secret plan" }, memoryEmbedder);
    expect(bHits).toHaveLength(0);
    // Correcting A's id under B's workspace is a not-found (RLS-invisible).
    await expect(correctWorkspaceMemory(dbClient.db, {
      accountId: grantB.accountId, workspaceId: grantB.workspaceId, id: inA.memory.id,
    }, memoryEmbedder)).rejects.toThrow(/not found/i);
  });

  test("AC-3: per-workspace visible-record cap rejects further saves", async () => {
    const grant = await testGrant(dbClient.db);
    // Bulk-seed exactly the visible cap in one statement (fast), including an
    // approved row so saveWorkspaceMemory must count active ∪ approved.
    const activeFillCount = MEMORY_VISIBLE_RECORD_CAP - 1;
    await dbClient.db.execute(dbSql`
      insert into knowledge_memories (account_id, workspace_id, status, kind, scope, text, text_hash)
      select ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, 'active', 'semantic', 'workspace',
             'capfill ' || g, 'caphash-' || g
      from generate_series(1, ${activeFillCount}) as g
      union all
      select ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, 'approved', 'semantic', 'workspace',
             'approved capfill', 'approved-caphash'
    `);
    await expect(saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId, text: "One over the cap.",
    }, memoryEmbedder)).rejects.toThrow(/full/i);

    const [victim] = await dbClient.db.execute<{ id: string }>(dbSql`
      select id from knowledge_memories
      where workspace_id = ${grant.workspaceId}::uuid and status = 'active'
      order by text
      limit 1
    `);
    expect(victim?.id).toBeTruthy();
    const replacement = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      text: "At-cap replacement succeeds by retiring one active row.",
      replacesId: victim!.id,
    }, memoryEmbedder);
    expect(replacement.deduped).toBe(false);
    expect(replacement.superseded?.id).toBe(victim!.id);
    expect(replacement.memory.status).toBe("active");

    const [{ visibleCount } = { visibleCount: 0 }] = await dbClient.db.execute<{ visibleCount: number }>(dbSql`
      select count(*)::int as "visibleCount" from knowledge_memories
      where workspace_id = ${grant.workspaceId}::uuid and status in ('active', 'approved')
    `);
    expect(Number(visibleCount)).toBe(MEMORY_VISIBLE_RECORD_CAP);
  });

  test("AC-7: working-set block reflects the memory setting and record state", async () => {
    const grant = await testGrant(dbClient.db);
    // Setting off → null (injection no-ops) even with records present.
    await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId, text: "Prefer Terraform for infra.", kind: "preference",
    }, memoryEmbedder);
    expect(await resolveWorkspaceMemoryBlock(dbClient.db, grant.workspaceId)).toBeNull();

    await enableWorkspaceMemory(grant.workspaceId);
    await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId, text: "Staging deploys from main.", kind: "semantic",
    }, memoryEmbedder);
    await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId, workspaceId: grant.workspaceId, text: "A one-off thing that happened.", kind: "episodic",
    }, memoryEmbedder);
    const block = await resolveWorkspaceMemoryBlock(dbClient.db, grant.workspaceId);
    expect(block).toContain("## Workspace memory");
    expect(block).toContain("### Preferences");
    expect(block).toContain("Prefer Terraform for infra.");
    expect(block).toContain("Staging deploys from main.");
    // Episodic is excluded from the injected block.
    expect(block).not.toContain("one-off thing");

    // Enabled but empty → the empty-state bootstrap block, not null.
    const empty = await testGrant(dbClient.db);
    await enableWorkspaceMemory(empty.workspaceId);
    const emptyBlock = await resolveWorkspaceMemoryBlock(dbClient.db, empty.workspaceId);
    expect(emptyBlock).toContain("currently empty");
  });

  test("RLS policies isolate capability, pack, and social rows for a non-owner app role", async () => {
    const appRoleUrl = await createRlsAppRole(dbClient.db, services.databaseUrl);
    const appDbClient = createDb(appRoleUrl);
    try {
      const grantA = await testGrant(dbClient.db);
      const grantB = await testGrant(dbClient.db);
      await seedCapabilityPackAndSocialRows(dbClient.db, grantB);

      for (const table of newCapabilityTables) {
        const hidden = await appDbClient.db.execute(dbSql<{ count: string }>`select count(*)::text as count from ${dbSql.raw(table)}`);
        expect(Number(hidden[0]?.count ?? 0)).toBe(0);
      }

      await withRlsContext(appDbClient.db, grantA, async (db) => {
        await seedCapabilityPackAndSocialRows(db, grantA);
      });

      for (const table of newCapabilityTables) {
        const visible = await withRlsContext(appDbClient.db, grantA, async (db) =>
          await db.execute(dbSql<{ workspace_id: string }>`select workspace_id::text from ${dbSql.raw(table)} order by workspace_id asc`)
        );
        expect(visible.map((row) => row.workspace_id)).toEqual([grantA.workspaceId]);
      }

      await expect(withRlsContext(appDbClient.db, grantA, async (db) => {
        await db.execute(dbSql`
          insert into pack_installations (account_id, workspace_id, pack_id)
          values (${grantA.accountId}, ${grantB.workspaceId}, ${`mismatched-${crypto.randomUUID()}`})
        `);
      })).rejects.toThrow();
    } finally {
      await appDbClient.close();
    }
  });

  test("RLS policies isolate workspace environment rows for a non-owner app role", async () => {
    const appRoleUrl = await createRlsAppRole(dbClient.db, services.databaseUrl);
    const appDbClient = createDb(appRoleUrl);
    try {
      const grantA = await testGrant(dbClient.db);
      const grantB = await testGrant(dbClient.db);
      await seedWorkspaceEnvironmentRows(dbClient.db, grantB);

      for (const table of ["workspace_environments", "workspace_environment_variables"]) {
        const hidden = await appDbClient.db.execute(dbSql<{ count: string }>`select count(*)::text as count from ${dbSql.raw(table)}`);
        expect(Number(hidden[0]?.count ?? 0)).toBe(0);
      }

      await withRlsContext(appDbClient.db, grantA, async (db) => {
        await seedWorkspaceEnvironmentRows(db, grantA);
      });

      for (const table of ["workspace_environments", "workspace_environment_variables"]) {
        const visible = await withRlsContext(appDbClient.db, grantA, async (db) =>
          await db.execute(dbSql<{ workspace_id: string }>`select workspace_id::text from ${dbSql.raw(table)}`)
        );
        expect(visible.map((row) => row.workspace_id)).toEqual([grantA.workspaceId]);
      }

      await expect(withRlsContext(appDbClient.db, grantA, async (db) => {
        await db.execute(dbSql`
          insert into workspace_environments (account_id, workspace_id, name)
          values (${grantA.accountId}, ${grantB.workspaceId}, ${`mismatched-${crypto.randomUUID()}`})
        `);
      })).rejects.toThrow();
    } finally {
      await appDbClient.close();
    }
  });

  test("exports only runtime-ready enabled MCP capability servers", async () => {
    const grant = await testGrant(dbClient.db);
    const otherGrant = await testGrant(dbClient.db);
    const capabilityId = `mcp:test-${crypto.randomUUID()}`;
    await upsertCapabilityCatalogItem(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      id: capabilityId,
      kind: "mcp",
      source: "manual",
      name: "Test MCP",
      endpointUrl: "https://example.com/mcp",
      metadata: { mcpServerId: "cap-test-ready" },
    });
    await enableCapabilityInstallation(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      capabilityId,
      kind: "mcp",
      metadata: {},
    });
    expect((await listEnabledMcpCapabilityServers(dbClient.db, grant.workspaceId)).some((server) => server.capabilityId === capabilityId)).toBe(false);

    await enableCapabilityInstallation(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      capabilityId,
      kind: "mcp",
      metadata: { mcpConnectivity: { status: "ok", checkedAt: new Date().toISOString(), toolCount: 1 } },
    });
    expect((await listEnabledMcpCapabilityServers(dbClient.db, grant.workspaceId)).some((server) => server.capabilityId === capabilityId)).toBe(true);
    expect((await listEnabledMcpCapabilityServers(dbClient.db, otherGrant.workspaceId)).some((server) => server.capabilityId === capabilityId)).toBe(false);

    const gatedCapabilityId = `mcp:gated-${crypto.randomUUID()}`;
    await upsertCapabilityCatalogItem(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      id: gatedCapabilityId,
      kind: "mcp",
      source: "manual",
      name: "Gated MCP",
      endpointUrl: "https://secure.example/mcp",
      authModel: "credential_ref",
      metadata: { mcpServerId: "cap-test-gated" },
    });
    await enableCapabilityInstallation(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      capabilityId: gatedCapabilityId,
      kind: "mcp",
      metadata: { mcpConnectivity: { status: "ok", checkedAt: new Date().toISOString(), toolCount: 1 } },
    });
    expect((await listEnabledMcpCapabilityServers(dbClient.db, grant.workspaceId)).some((server) => server.capabilityId === gatedCapabilityId)).toBe(false);
  });

  test("applyContextCompaction supersedes the prefix, inserts one active summary, and keeps the audit trail", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "compaction",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    // 6 items: two old turns [0..3] and a recent turn [4..5]. Boundary at the
    // recent user message (position 4); summary goes at the freed position 3.
    await appendSessionHistoryItems(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      items: [
        { position: 0, item: { type: "message", role: "user", content: "old turn 1" } },
        { position: 1, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "a1" }] } },
        { position: 2, item: { type: "message", role: "user", content: "old turn 2" } },
        { position: 3, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "a2" }] } },
        { position: 4, item: { type: "message", role: "user", content: "recent turn" } },
        { position: 5, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "a3" }] } },
      ],
    });

    await applyContextCompaction(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      boundaryPosition: 4,
      // Fractional: a half-step before the kept tail. Collides with NO real row,
      // so the real prefix row at position 3 is never overwritten.
      summaryPosition: 3.5,
      summaryItem: { type: "message", role: "user", content: "[CONTEXT CHECKPOINT] SUMMARY:folded", opengeni_context_summary: true },
    });

    // Active read = [summary @3.5, recent user @4, assistant @5].
    const active = await getActiveSessionHistoryItems(dbClient.db, grant.workspaceId, session.id);
    expect(active.map((row) => row.position)).toEqual([3.5, 4, 5]);
    expect((active[0]!.item as Record<string, unknown>).opengeni_context_summary).toBe(true);
    expect(active[1]!.item).toMatchObject({ role: "user", content: "recent turn" });

    // Audit trail preserved: every original prefix row STILL EXISTS — including
    // position 3, the row the old (boundaryPosition - 1) placement overwrote.
    // The summary is an ADDITIONAL row, so total count grew by exactly one.
    const all = await getSessionHistoryItems(dbClient.db, grant.workspaceId, session.id);
    expect(all.map((row) => row.position).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 3.5, 4, 5]);
    expect(await countSessionHistoryItems(dbClient.db, grant.workspaceId, session.id)).toBe(7);

    // The exact audit-loss regression: the original assistant 'a2' at position 3
    // must still be retrievable verbatim after compaction (the bug overwrote it
    // with the summary). Assert the real item survives untouched.
    const positionThree = all.find((row) => row.position === 3);
    expect(positionThree).toBeDefined();
    expect(positionThree!.item).toMatchObject({ role: "assistant", content: [{ type: "output_text", text: "a2" }] });
    expect((positionThree!.item as Record<string, unknown>).opengeni_context_summary).toBeUndefined();
  });

  test("applyContextCompaction is idempotent on a retry (same summary position)", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "compaction-retry",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await appendSessionHistoryItems(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      items: [
        { position: 0, item: { type: "message", role: "user", content: "old" } },
        { position: 1, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "a1" }] } },
        { position: 2, item: { type: "message", role: "user", content: "recent" } },
      ],
    });
    const apply = () => applyContextCompaction(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      boundaryPosition: 2,
      summaryPosition: 1.5,
      summaryItem: { type: "message", role: "user", content: "SUMMARY:s", opengeni_context_summary: true },
    });
    await apply();
    await apply(); // retry must not duplicate, throw, or overwrite the real row
    const active = await getActiveSessionHistoryItems(dbClient.db, grant.workspaceId, session.id);
    expect(active.map((row) => row.position)).toEqual([1.5, 2]);
    // The retry-idempotent insert (onConflictDoNothing) must not have touched the
    // real superseded row at position 1: it survives verbatim, exactly once.
    const all = await getSessionHistoryItems(dbClient.db, grant.workspaceId, session.id);
    const positionOne = all.filter((row) => row.position === 1);
    expect(positionOne).toHaveLength(1);
    expect(positionOne[0]!.item).toMatchObject({ role: "assistant", content: [{ type: "output_text", text: "a1" }] });
    // Exactly one summary row total (no duplicate from the retry).
    expect(all.filter((row) => (row.item as Record<string, unknown>).opengeni_context_summary === true)).toHaveLength(1);
  });

  test("setSessionLastInputTokens persists the pre-turn compaction signal", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "tokens",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.lastInputTokens).toBeNull();
    await setSessionLastInputTokens(dbClient.db, grant.workspaceId, session.id, 654_321);
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.lastInputTokens).toBe(654_321);
  });

  test("clearSessionContext supersedes all live history, keeps the audit trail, and defeats the RunState fallback", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "clear",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await appendSessionHistoryItems(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      items: [
        { position: 0, item: { type: "message", role: "user", content: "secret one" } },
        { position: 1, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "secret two" }] } },
        { position: 2, item: { type: "message", role: "user", content: "secret three" } },
      ],
    });
    // A stale RunState blob carrying the old conversation — the resurrection
    // vector clear must neutralize (run-input.ts falls back to this when the
    // active items read is empty).
    await saveRunState(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      serializedRunState: JSON.stringify({ history: ["secret one", "secret two"] }),
      pendingApprovals: [],
    });
    await setSessionLastInputTokens(dbClient.db, grant.workspaceId, session.id, 50_000);

    const result = await clearSessionContext(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
    });
    expect(result.supersededItems).toBe(3);
    expect(result.markerPosition).toBe(3);

    // (a)+(b): the active read returns ONLY the neutral marker (length 1, not
    // 0) so messageInput stays on the items route, away from the RunState blob.
    const active = await getActiveSessionHistoryItems(dbClient.db, grant.workspaceId, session.id);
    expect(active).toHaveLength(1);
    expect(active[0]!.item).toMatchObject({ role: "user", content: "[context cleared]" });

    // Audit trail preserved: the three superseded rows still exist.
    const all = await getSessionHistoryItems(dbClient.db, grant.workspaceId, session.id);
    expect(all.map((row) => row.position).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);

    // (c): the latest run state now reflects the clear (no old conversation).
    const latest = await getLatestRunState(dbClient.db, grant.workspaceId, session.id);
    expect(latest!.serializedRunState).not.toContain("secret");
    expect(latest!.pendingApprovals).toEqual([]);

    // last_input_tokens reset so the next turn's trigger starts fresh.
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.lastInputTokens).toBe(0);
  });

  test("clearSessionContext is idempotent — a re-run keeps exactly one active marker", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "clear-twice",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await appendSessionHistoryItems(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      items: [{ position: 0, item: { type: "message", role: "user", content: "x" } }],
    });
    await clearSessionContext(dbClient.db, { accountId: grant.accountId, workspaceId: grant.workspaceId, sessionId: session.id });
    await clearSessionContext(dbClient.db, { accountId: grant.accountId, workspaceId: grant.workspaceId, sessionId: session.id });
    const active = await getActiveSessionHistoryItems(dbClient.db, grant.workspaceId, session.id);
    expect(active).toHaveLength(1);
    expect(active[0]!.item).toMatchObject({ content: "[context cleared]" });
  });

  test("compaction request flag: request sets it, consume reports + clears it exactly once", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "compact-flag",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    // No request yet: consume is a no-op false.
    expect(await consumeSessionCompactionRequest(dbClient.db, grant.workspaceId, session.id)).toBe(false);
    await requestSessionCompaction(dbClient.db, grant.workspaceId, session.id);
    // First consumer wins; a second consumer sees it already cleared.
    expect(await consumeSessionCompactionRequest(dbClient.db, grant.workspaceId, session.id)).toBe(true);
    expect(await consumeSessionCompactionRequest(dbClient.db, grant.workspaceId, session.id)).toBe(false);
  });

  test("migration 0014 repair strips a legacy orphaned function_call_result, audits it, and spares valid pairs + dangling calls", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "orphan-repair",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    // A second session that must stay completely untouched — proves the repair
    // is session-scoped and never deletes a result whose call lives elsewhere.
    const otherSession = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "orphan-repair-other",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    // Legacy corruption: an orphaned function_call_result (no preceding call), a
    // valid call+result pair, and a trailing dangling call (valid mid-turn).
    await appendSessionHistoryItems(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      items: [
        { position: 0, item: { type: "message", role: "user", content: "go" } },
        { position: 1, item: { type: "function_call_result", callId: "orphan_x", output: { type: "text", text: "leaked" } } },
        { position: 2, item: { type: "function_call", callId: "paired", name: "tool", arguments: "{}" } },
        { position: 3, item: { type: "function_call_result", callId: "paired", output: { type: "text", text: "ok" } } },
        // snake_case orphan: a result whose call_id has no earlier call.
        { position: 4, item: { type: "shell_call_output", call_id: "orphan_snake", output: "leaked2" } },
        { position: 5, item: { type: "function_call", callId: "dangling", name: "tool", arguments: "{}" } },
      ],
    });
    // The other session holds a call with the SAME id as this session's orphan,
    // to prove cross-session call presence does NOT spare an orphan (scoping).
    await appendSessionHistoryItems(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: otherSession.id,
      items: [
        { position: 0, item: { type: "function_call", callId: "orphan_x", name: "tool", arguments: "{}" } },
        { position: 1, item: { type: "function_call_result", callId: "orphan_x", output: { type: "text", text: "ok" } } },
      ],
    });

    // Run the ACTUAL shipped migration SQL against the live DB. CREATE TABLE IF
    // NOT EXISTS and the GRANT block make re-running it (already applied in
    // beforeAll) idempotent; the CTE DELETE re-evaluates the new orphans.
    const migrationPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../packages/db/drizzle/0014_repair_orphaned_function_call_results.sql",
    );
    const migrationSql = await readFile(migrationPath, "utf8");
    await applyRawSql(services.databaseUrl, migrationSql);

    // The two orphans are gone; everything else survives in order.
    const remaining = await getSessionHistoryItems(dbClient.db, grant.workspaceId, session.id);
    expect(remaining.map((row) => row.position).sort((a, b) => a - b)).toEqual([0, 2, 3, 5]);
    const remainingTypes = remaining
      .sort((a, b) => a.position - b.position)
      .map((row) => (row.item as Record<string, unknown>).type);
    expect(remainingTypes).toEqual(["message", "function_call", "function_call_result", "function_call"]);
    // The dangling call (valid mid-turn) was NOT deleted.
    expect(remaining.some((row) => (row.item as Record<string, unknown>).callId === "dangling")).toBe(true);
    // Neither orphan survives.
    expect(remaining.some((row) => (row.item as Record<string, unknown>).callId === "orphan_x")).toBe(false);
    expect(remaining.some((row) => (row.item as Record<string, unknown>).call_id === "orphan_snake")).toBe(false);

    // The other session is completely untouched (scoping).
    const otherRemaining = await getSessionHistoryItems(dbClient.db, grant.workspaceId, otherSession.id);
    expect(otherRemaining.map((row) => row.position).sort((a, b) => a - b)).toEqual([0, 1]);

    // Both deleted orphans were audited verbatim into the permanent audit table.
    const audit = await dbClient.db.execute(dbSql`
      select source_id, position, item, repair_reason
      from session_history_items_repair_audit
      where session_id = ${session.id}
      order by position
    `);
    const auditRows = audit as unknown as Array<{ position: number; item: Record<string, unknown>; repair_reason: string }>;
    expect(auditRows).toHaveLength(2);
    expect(auditRows.map((r) => Number(r.position)).sort((a, b) => a - b)).toEqual([1, 4]);
    expect(auditRows.every((r) => r.repair_reason === "orphaned_tool_call_result_no_matching_call")).toBe(true);
    const auditedCallIds = auditRows.map((r) => r.item.callId ?? r.item.call_id);
    expect(auditedCallIds.sort()).toEqual(["orphan_snake", "orphan_x"]);
  });
});

const newCapabilityTables = [
  "pack_installations",
  "capability_catalog_items",
  "capability_installations",
  "social_connections",
  "social_posts",
];

async function seedCapabilityPackAndSocialRows(db: ReturnType<typeof createDb>["db"], grant: AccessGrant): Promise<void> {
  const suffix = crypto.randomUUID();
  const capabilityId = `mcp:rls-${suffix}`;
  const connectionId = crypto.randomUUID();
  await db.execute(dbSql`
    insert into pack_installations (account_id, workspace_id, pack_id)
    values (${grant.accountId}, ${grant.workspaceId}, ${`pack-${suffix}`})
  `);
  await db.execute(dbSql`
    insert into capability_catalog_items (id, account_id, workspace_id, kind, source, name, endpoint_url)
    values (${capabilityId}, ${grant.accountId}, ${grant.workspaceId}, 'mcp', 'manual', ${`RLS MCP ${suffix}`}, 'https://example.com/mcp')
  `);
  await db.execute(dbSql`
    insert into capability_installations (account_id, workspace_id, capability_id, kind)
    values (${grant.accountId}, ${grant.workspaceId}, ${capabilityId}, 'mcp')
  `);
  await db.execute(dbSql`
    insert into social_connections (id, account_id, workspace_id, provider, account_handle)
    values (${connectionId}, ${grant.accountId}, ${grant.workspaceId}, 'linkedin', ${`handle-${suffix}`})
  `);
  await db.execute(dbSql`
    insert into social_posts (account_id, workspace_id, connection_id, provider, external_post_id, text, published_at)
    values (${grant.accountId}, ${grant.workspaceId}, ${connectionId}, 'linkedin', ${`post-${suffix}`}, 'RLS post', now())
  `);
}

async function seedWorkspaceEnvironmentRows(db: ReturnType<typeof createDb>["db"], grant: AccessGrant): Promise<void> {
  const suffix = crypto.randomUUID();
  const environmentId = crypto.randomUUID();
  await db.execute(dbSql`
    insert into workspace_environments (id, account_id, workspace_id, name)
    values (${environmentId}, ${grant.accountId}, ${grant.workspaceId}, ${`rls-environment-${suffix}`})
  `);
  await db.execute(dbSql`
    insert into workspace_environment_variables (account_id, workspace_id, environment_id, name, value_encrypted)
    values (${grant.accountId}, ${grant.workspaceId}, ${environmentId}, 'RLS_TOKEN', 'v1:placeholder:placeholder')
  `);
}

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
