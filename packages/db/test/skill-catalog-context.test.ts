import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readSkillCatalogContext, skillCatalogContextItem } from "@opengeni/contracts";
import {
  createDb,
  bootstrapWorkspace,
  createSession,
  withWorkspaceSubjectSessionActivityRls,
  submitHumanPromptInTransaction,
  claimSessionWorkForAttempt,
  ensureSessionSkillCatalog,
  getActiveSessionHistoryItems,
  applySessionTurnSettlement,
  applyContextCompaction,
  requestSessionCompaction,
} from "../src/index";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("skill-catalog-context");
  if (!db) throw new Error("test postgres unavailable");
  shared = db;
  client = createDb(db.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "skills",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "skills",
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
  async function claim(maintenance = false) {
    if (maintenance) await requestSessionCompaction(client.db, workspaceId, session.id);
    else
      await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, grant.subjectId, (db) =>
        submitHumanPromptInTransaction(db, {
          accountId: grant.accountId,
          workspaceId,
          sessionId: session.id,
          subjectId: grant.subjectId,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "work",
          resources: [],
          reasoningEffort: "low",
          reasoningEffortFallback: "low",
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
  const identity = (turn: Awaited<ReturnType<typeof claim>>) => ({
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    turnId: turn.id,
    expectedExecutionGeneration: turn.executionGeneration,
    expectedAttemptId: turn.activeAttemptId!,
  });
  const settle = (turn: Awaited<ReturnType<typeof claim>>) =>
    applySessionTurnSettlement(client.db, workspaceId, {
      sessionId: session.id,
      turnId: turn.id,
      triggerEventId: turn.triggerEventId,
      attemptId: turn.activeAttemptId!,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: {} }],
    });
  const history = () => getActiveSessionHistoryItems(client.db, workspaceId, session.id);
  const install = (turn: Awaited<ReturnType<typeof claim>>, catalog: string) =>
    ensureSessionSkillCatalog(client.db, { ...identity(turn), catalog });
  return { claim, identity, settle, history, install };
}

test("catalog changes append without rewriting history; unchanged turns and retries freeze the same snapshot", async () => {
  const f = await fixture();
  const first = await f.claim();
  expect(await f.install(first, "A")).toBe("A");
  const original = await f.history();
  expect(readSkillCatalogContext(original[0]!.item)).toBe("A");
  expect(original[1]!.item.role).toBe("user");
  expect(await f.install(first, "changed during retry")).toBe("A");
  expect(await f.history()).toEqual(original);
  await f.settle(first);
  const second = await f.claim();
  expect(await f.install(second, "A")).toBe("A");
  // Even without a newly appended catalog, this logical turn's choice is frozen.
  expect(await f.install(second, "changed during retry")).toBe("A");
  const unchanged = await f.history();
  expect(unchanged.filter((row) => readSkillCatalogContext(row.item) !== null)).toHaveLength(1);
  expect(unchanged.slice(0, original.length)).toEqual(original);
  await f.settle(second);
  const third = await f.claim();
  expect(await f.install(third, "B")).toBe("B");
  const updated = await f.history();
  expect(updated.slice(0, unchanged.length)).toEqual(unchanged);
  expect(readSkillCatalogContext(updated.at(-2)!.item)).toBe("B");
  expect(updated.at(-1)!.item.role).toBe("user");
  await expect(f.install(first, "stale")).rejects.toThrow("fenced");
  const compacted = await applyContextCompaction(client.db, {
    ...f.identity(third),
    replacementItems: [skillCatalogContextItem("B")],
    summaryItem: { type: "compaction", encrypted_content: "test" },
  });
  expect(compacted.applied).toBe(true);
  // Receipt still resolves the original row even after it became inactive.
  expect(await f.install(third, "C")).toBe("B");
  expect(await f.history()).toHaveLength(2);
  await f.settle(third);
  const fourth = await f.claim();
  expect(await f.install(fourth, "B")).toBe("B");
  expect(
    (await f.history()).filter((row) => readSkillCatalogContext(row.item) !== null),
  ).toHaveLength(1);
}, 180_000);

test("maintenance installs a catalog without inventing user input", async () => {
  const f = await fixture();
  const turn = await f.claim(true);
  expect(await f.install(turn, "No Skills available")).toBe("No Skills available");
  expect(await f.install(turn, "retry change")).toBe("No Skills available");
  const history = await f.history();
  expect(history).toHaveLength(1);
  expect(history[0]!.item.role).toBe("developer");
}, 180_000);
