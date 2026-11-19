import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { readWorkspaceFilesystemContext } from "@opengeni/contracts";
import {
  createDb,
  bootstrapWorkspace,
  createSession,
  withWorkspaceSubjectSessionActivityRls,
  submitHumanPromptInTransaction,
  claimSessionWorkForAttempt,
  ensureSessionWorkspaceFilesystem,
  getActiveSessionHistoryItems,
  applySessionTurnSettlement,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("workspace-filesystem-context");
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
    accountName: "filesystem",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "filesystem",
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
  async function claim() {
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
  type Turn = Awaited<ReturnType<typeof claim>>;
  const layout = (turn: Turn, value: string | null) =>
    ensureSessionWorkspaceFilesystem(client.db, {
      accountId: grant.accountId,
      workspaceId,
      sessionId: session.id,
      turnId: turn.id,
      expectedExecutionGeneration: turn.executionGeneration,
      expectedAttemptId: turn.activeAttemptId!,
      layout: value,
    });
  const settle = (turn: Turn) =>
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
  const layouts = async () =>
    (await history())
      .map((row) => readWorkspaceFilesystemContext(row.item))
      .filter((value) => value !== null);
  return { claim, settle, history, layout, layouts };
}

test("a machine move adds a layout item before the next turn and never rewrites earlier history", async () => {
  const f = await fixture();
  const first = await f.claim();
  expect(await f.layout(first, "/workspace")).toBe("/workspace");
  const original = await f.history();
  expect(original.map((row) => readWorkspaceFilesystemContext(row.item))[0]).toBe("/workspace");
  expect(original[1]!.item.role).toBe("user");
  // A swap within the turn starts a new attempt that keeps the turn's snapshot;
  // the swap's own tool result tells the model the new root.
  expect(await f.layout(first, "/home/person")).toBe("/workspace");
  expect(await f.history()).toEqual(original);
  await f.settle(first);

  const second = await f.claim();
  expect(await f.layout(second, "/home/person")).toBe("/home/person");
  const moved = await f.history();
  expect(moved.slice(0, original.length)).toEqual(original);
  expect(await f.layouts()).toEqual(["/workspace", "/home/person"]);
  await f.settle(second);

  // The same machine on a later turn writes nothing.
  const third = await f.claim();
  expect(await f.layout(third, "/home/person")).toBe("/home/person");
  expect(await f.layouts()).toEqual(["/workspace", "/home/person"]);
  // A turn without a sandbox keeps what the model last read.
  await f.settle(third);
  const fourth = await f.claim();
  expect(await f.layout(fourth, null)).toBe("/home/person");
  expect(await f.layouts()).toEqual(["/workspace", "/home/person"]);
}, 180_000);
