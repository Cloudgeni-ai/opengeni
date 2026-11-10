import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { readRepositorySkillsContext, readSkillCatalogContext } from "@opengeni/contracts";
import {
  createDb,
  bootstrapWorkspace,
  createSession,
  withWorkspaceSubjectSessionActivityRls,
  submitHumanPromptInTransaction,
  claimSessionWorkForAttempt,
  ensureSessionRepositorySkills,
  ensureSessionSkillCatalog,
  readActiveSessionHistory,
  applySessionTurnSettlement,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("repository-skills-context");
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
    accountName: "repository skills",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "repository skills",
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
  const identity = (turn: Turn) => ({
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    turnId: turn.id,
    expectedExecutionGeneration: turn.executionGeneration,
    expectedAttemptId: turn.activeAttemptId!,
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
  const history = async () =>
    (await readActiveSessionHistory(client.db, workspaceId, session.id)).items.map(
      ({ id, position, turnId, item }) => ({ id, position, turnId, item }),
    );
  const indexes = async () =>
    (await history())
      .map((row) => readRepositorySkillsContext(row.item))
      .filter((value) => value !== null);
  const publish = (turn: Turn, index: string | null, empty = false) =>
    ensureSessionRepositorySkills(client.db, {
      ...identity(turn),
      index,
      ...(empty ? { omitWhenAbsent: true } : {}),
    });
  const catalog = (turn: Turn, text: string) =>
    ensureSessionSkillCatalog(client.db, { ...identity(turn), catalog: text });
  return { claim, settle, history, indexes, publish, catalog };
}

test("a changed index is a history item before its turn; earlier items never change", async () => {
  const f = await fixture();
  const first = await f.claim();
  expect(await f.publish(first, "Index A")).toBe("Index A");
  const original = await f.history();
  expect(original.map((row) => readRepositorySkillsContext(row.item))).toEqual(["Index A", null]);
  expect(original[0]!.turnId).toBe(first.id);
  expect(original[1]!.item.role).toBe("user");
  // A retry of the same turn keeps its snapshot even if the workspace changed.
  expect(await f.publish(first, "Index B")).toBe("Index A");
  expect(await f.history()).toEqual(original);
  await f.settle(first);

  // An unchanged index writes nothing.
  const second = await f.claim();
  expect(await f.publish(second, "Index A")).toBe("Index A");
  const unchanged = await f.history();
  expect(unchanged.slice(0, original.length)).toEqual(original);
  expect(await f.indexes()).toEqual(["Index A"]);
  await f.settle(second);

  // A skill added mid-chat appends a new index before the turn that sees it.
  const third = await f.claim();
  expect(await f.publish(third, "Index B")).toBe("Index B");
  const updated = await f.history();
  expect(updated.slice(0, unchanged.length)).toEqual(unchanged);
  expect(readRepositorySkillsContext(updated.at(-2)!.item)).toBe("Index B");
  expect(updated.at(-2)!.turnId).toBe(third.id);
  expect(updated.at(-1)!.item.role).toBe("user");
}, 180_000);

test("an index that could not be read keeps what the model has", async () => {
  const f = await fixture();
  const first = await f.claim();
  expect(await f.publish(first, "Index A")).toBe("Index A");
  await f.settle(first);
  const before = await f.history();
  const second = await f.claim();
  expect(await f.publish(second, null)).toBe("Index A");
  expect((await f.history()).slice(0, before.length)).toEqual(before);
  expect(await f.indexes()).toEqual(["Index A"]);
  // Never indexed: nothing is written and the turn stays without an index.
  const g = await fixture();
  const only = await g.claim();
  expect(await g.publish(only, null)).toBeNull();
  expect(await g.publish(only, "Index A")).toBeNull();
  expect(await g.indexes()).toEqual([]);
}, 180_000);

test("unreachable then restored replaces the index each time it changes", async () => {
  const f = await fixture();
  const turns: string[] = [];
  for (const index of ["Index A", "Unreachable", "Unreachable", "Index A"]) {
    const turn = await f.claim();
    turns.push((await f.publish(turn, index))!);
    await f.settle(turn);
  }
  expect(turns).toEqual(["Index A", "Unreachable", "Unreachable", "Index A"]);
  expect(await f.indexes()).toEqual(["Index A", "Unreachable", "Index A"]);
}, 180_000);

test("an empty index is written only to replace an earlier one", async () => {
  const f = await fixture();
  const first = await f.claim();
  expect(await f.publish(first, "No skills", true)).toBeNull();
  expect(await f.indexes()).toEqual([]);
  await f.settle(first);
  const second = await f.claim();
  expect(await f.publish(second, "Index A")).toBe("Index A");
  await f.settle(second);
  const third = await f.claim();
  expect(await f.publish(third, "No skills", true)).toBe("No skills");
  expect(await f.indexes()).toEqual(["Index A", "No skills"]);
}, 180_000);

test("an index written during the run goes before the turn's earlier context items", async () => {
  const f = await fixture();
  const turn = await f.claim();
  // The Skill catalog is written before the run input is loaded; the index
  // only once discovery finishes inside the run.
  expect(await f.catalog(turn, "Skills")).toBe("Skills");
  expect(await f.publish(turn, "Index A")).toBe("Index A");
  const rows = await f.history();
  expect(rows.map((row) => row.turnId)).toEqual([turn.id, turn.id, turn.id]);
  expect(readRepositorySkillsContext(rows[0]!.item)).toBe("Index A");
  expect(readSkillCatalogContext(rows[1]!.item)).toBe("Skills");
  expect(rows[2]!.item.role).toBe("user");
}, 180_000);
