import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  bootstrapWorkspace,
  createSession,
  withWorkspaceSubjectSessionActivityRls,
  submitHumanPromptInTransaction,
  claimSessionWorkForAttempt,
  ensureSessionReasoningConfiguration,
  getActiveSessionHistoryItems,
  applySessionTurnSettlement,
  applyContextCompaction,
  requestSessionCompaction,
} from "../src/index";
import { readReasoningConfiguration } from "@opengeni/codex";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("reasoning-configuration");
  if (!db) throw new Error("test postgres unavailable");
  shared = db;
  client = createDb(db.appUrl);
}, 180_000);

test("manual compaction installs configuration without a user-input row", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "maintenance",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "maintenance",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "high",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await requestSessionCompaction(client.db, workspaceId, session.id);
  const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("maintenance not claimed");
  expect(claimed.turn.source).toBe("compaction");
  expect(await getActiveSessionHistoryItems(client.db, workspaceId, session.id)).toHaveLength(0);
  const identity = {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    turnId: claimed.turn.id,
    expectedExecutionGeneration: claimed.turn.executionGeneration,
    expectedAttemptId: claimed.turn.activeAttemptId!,
    effort: "high" as const,
  };
  expect(await ensureSessionReasoningConfiguration(client.db, identity)).toBe("high");
  expect(await ensureSessionReasoningConfiguration(client.db, identity)).toBe("high");
  const history = await getActiveSessionHistoryItems(client.db, workspaceId, session.id);
  expect(history).toHaveLength(1);
  expect(readReasoningConfiguration(history[0]!.item)?.effort).toBe("high");
  expect(history.some((row) => row.item.role === "user")).toBe(false);
  expect(
    (
      await applyContextCompaction(client.db, {
        ...identity,
        replacementItems: [],
        summaryItem: { type: "compaction", encrypted_content: "test" },
        trailingItems: [history[0]!.item],
      })
    ).applied,
  ).toBe(true);
  expect(await ensureSessionReasoningConfiguration(client.db, identity)).toBe("high");
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);
test("effort changes persist once before accepted input while baseline stays fixed and stale attempts fail", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "reasoning",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "reasoning",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  async function claim(effort: "low" | "high") {
    await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, grant.subjectId, (db) =>
      submitHumanPromptInTransaction(db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: `do ${effort}`,
        resources: [],
        reasoningEffort: effort,
        reasoningEffortFallback: effort,
        source: "user",
      }),
    );
    const result = await claimSessionWorkForAttempt(client.db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (result.action !== "claimed") throw new Error("not claimed");
    return result.turn;
  }
  const first = await claim("low");
  const identity = (turn: typeof first, effort: "low" | "high") => ({
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    turnId: turn.id,
    expectedExecutionGeneration: turn.executionGeneration,
    expectedAttemptId: turn.activeAttemptId!,
    effort,
  });
  expect(await ensureSessionReasoningConfiguration(client.db, identity(first, "low"))).toBe("low");
  expect(await ensureSessionReasoningConfiguration(client.db, identity(first, "low"))).toBe("low");
  const original = await getActiveSessionHistoryItems(client.db, workspaceId, session.id);
  expect(original.filter((row) => readReasoningConfiguration(row.item))).toHaveLength(1);
  expect(readReasoningConfiguration(original[0]!.item)?.effort).toBe("low");
  await applySessionTurnSettlement(client.db, workspaceId, {
    sessionId: session.id,
    turnId: first.id,
    triggerEventId: first.triggerEventId,
    attemptId: first.activeAttemptId!,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: {} }],
  });
  const second = await claim("high");
  expect(await ensureSessionReasoningConfiguration(client.db, identity(second, "high"))).toBe(
    "low",
  );
  const updated = await getActiveSessionHistoryItems(client.db, workspaceId, session.id);
  expect(updated.slice(0, original.length).map((row) => row.item)).toEqual(
    original.map((row) => row.item),
  );
  expect(
    updated
      .filter((row) => readReasoningConfiguration(row.item))
      .map((row) => readReasoningConfiguration(row.item)?.effort),
  ).toEqual(["low", "high"]);
  const control = [...updated].reverse().find((row) => readReasoningConfiguration(row.item))!.item;
  const compacted = await applyContextCompaction(client.db, {
    ...identity(second, "high"),
    replacementItems: [],
    summaryItem: { type: "compaction", encrypted_content: "test" },
    trailingItems: [control],
  });
  expect(compacted.applied).toBe(true);
  const replay = await getActiveSessionHistoryItems(client.db, workspaceId, session.id);
  expect(replay[0]!.item.type).toBe("compaction");
  expect(readReasoningConfiguration(replay[1]!.item)?.effort).toBe("high");
  expect(await ensureSessionReasoningConfiguration(client.db, identity(second, "high"))).toBe(
    "low",
  );
  await expect(
    ensureSessionReasoningConfiguration(client.db, identity(first, "low")),
  ).rejects.toThrow("fenced");
  await applySessionTurnSettlement(client.db, workspaceId, {
    sessionId: session.id,
    turnId: second.id,
    triggerEventId: second.triggerEventId,
    attemptId: second.activeAttemptId!,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: {} }],
  });
  // A turn run while the feature is disabled can leave an older control behind.
  const third = await claim("low");
  await applySessionTurnSettlement(client.db, workspaceId, {
    sessionId: session.id,
    turnId: third.id,
    triggerEventId: third.triggerEventId,
    attemptId: third.activeAttemptId!,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: {} }],
  });
  const beforeMaintenance = await getActiveSessionHistoryItems(client.db, workspaceId, session.id);
  await requestSessionCompaction(client.db, workspaceId, session.id);
  const maintenance = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (maintenance.action !== "claimed") throw new Error("maintenance not claimed");
  expect(maintenance.turn.source).toBe("compaction");
  expect(
    await ensureSessionReasoningConfiguration(client.db, identity(maintenance.turn, "low")),
  ).toBe("low");
  expect(
    await ensureSessionReasoningConfiguration(client.db, identity(maintenance.turn, "low")),
  ).toBe("low");
  const afterMaintenance = await getActiveSessionHistoryItems(client.db, workspaceId, session.id);
  expect(afterMaintenance.slice(0, -1)).toEqual(beforeMaintenance);
  const tail = afterMaintenance.at(-1)!;
  expect(readReasoningConfiguration(tail.item)?.effort).toBe("low");
  expect(tail.position).toBeGreaterThan(
    Math.max(
      ...updated.map((row) => row.position),
      ...beforeMaintenance.map((row) => row.position),
    ),
  );
}, 180_000);
