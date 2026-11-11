import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  readSkillCatalogContext,
  readWorkspaceGovernanceContext,
  WORKSPACE_GOVERNANCE_NONE,
} from "@opengeni/contracts";
import {
  createDb,
  bootstrapWorkspace,
  createSession,
  withWorkspaceSubjectSessionActivityRls,
  submitHumanPromptInTransaction,
  claimSessionWorkForAttempt,
  ensureSessionSkillCatalog,
  ensureSessionWorkspaceGovernance,
  getActiveSessionHistoryItems,
  applySessionTurnSettlement,
  ensureManagedAccessForUser,
  forkSessionContent,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("workspace-governance-context");
  if (!db) throw new Error("test postgres unavailable");
  shared = db;
  client = createDb(db.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

/** A plain workspace, or a managed organization whose sessions can be forked. */
async function workspace(forkable: boolean) {
  const suffix = crypto.randomUUID();
  if (!forkable) {
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: suffix,
      accountName: "governance",
      workspaceExternalSource: "test",
      workspaceExternalId: suffix,
      workspaceName: "governance",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    return {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      subjectId: grant.subjectId,
    };
  }
  const userId = `governance-owner-${suffix}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Governance owner",
  });
  const grant = access.workspaceGrants.find(
    (candidate) => candidate.workspaceId === access.defaultWorkspaceId,
  );
  if (!grant?.workspaceId) throw new Error("owner has no shared workspace grant");
  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${grant.accountId}, 1, ${"5".repeat(64)}, ${"6".repeat(64)}, 'governance-test')`;
  await shared.admin`
    insert into organization_private_session_settings (
      account_id, enabled, version, updated_by_membership_id
    ) values (${grant.accountId}, true, 1, null)
    on conflict (account_id) do update set enabled = true`;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: `user:${userId}`,
  };
}

async function fixture(forkable = false) {
  const grant = await workspace(forkable);
  const workspaceId = grant.workspaceId;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    ...(forkable ? { visibility: "workspace_shared" as const } : {}),
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
  const history = () => getActiveSessionHistoryItems(client.db, workspaceId, session.id);
  const governed = async () =>
    (await history())
      .map((row) => readWorkspaceGovernanceContext(row.item))
      .filter((value) => value !== null);
  const govern = (turn: Turn, governance: string | null) =>
    ensureSessionWorkspaceGovernance(client.db, { ...identity(turn), governance });
  const catalog = (turn: Turn, text: string) =>
    ensureSessionSkillCatalog(client.db, { ...identity(turn), catalog: text });
  return {
    claim,
    settle,
    history,
    governed,
    govern,
    catalog,
    subjectId: grant.subjectId,
    workspaceId,
    sessionId: session.id,
  };
}

test("no governance writes nothing and stays frozen as none for the turn", async () => {
  const f = await fixture();
  const turn = await f.claim();
  expect(await f.govern(turn, null)).toBeNull();
  // A retry of the same logical turn keeps seeing none, even if governance appeared.
  expect(await f.govern(turn, "Rule A")).toBeNull();
  expect(await f.governed()).toEqual([]);
  expect((await f.history()).map((row) => row.item.role)).toEqual(["user"]);
}, 180_000);

test("governance is a history item before the turn that first sees it; changes append, never rewrite", async () => {
  const f = await fixture();
  const first = await f.claim();
  expect(await f.catalog(first, "Skills")).toBe("Skills");
  expect(await f.govern(first, "Rule A")).toBe("Rule A");
  const original = await f.history();
  // Both context items precede the user message of the turn that first sees them.
  expect(original.map((row) => readSkillCatalogContext(row.item))).toContain("Skills");
  expect(original.slice(0, 2).map((row) => readWorkspaceGovernanceContext(row.item))).toContain(
    "Rule A",
  );
  expect(original[2]!.item.role).toBe("user");
  // Retries (recovery attempts) reuse the frozen snapshot.
  expect(await f.govern(first, "changed mid-turn")).toBe("Rule A");
  expect(await f.history()).toEqual(original);
  await f.settle(first);

  const second = await f.claim();
  expect(await f.govern(second, "Rule A")).toBe("Rule A");
  const unchanged = await f.history();
  expect(unchanged.slice(0, original.length)).toEqual(original);
  expect(await f.governed()).toEqual(["Rule A"]);
  await f.settle(second);

  const third = await f.claim();
  expect(await f.govern(third, "Rule B")).toBe("Rule B");
  const updated = await f.history();
  expect(updated.slice(0, unchanged.length)).toEqual(unchanged);
  expect(readWorkspaceGovernanceContext(updated.at(-2)!.item)).toBe("Rule B");
  expect(updated.at(-1)!.item.role).toBe("user");
  await f.settle(third);

  // Withdrawn governance is stated explicitly, because the old block is still visible.
  const fourth = await f.claim();
  expect(await f.govern(fourth, null)).toBeNull();
  expect(await f.govern(fourth, "Rule C")).toBeNull();
  expect(await f.governed()).toEqual(["Rule A", "Rule B", WORKSPACE_GOVERNANCE_NONE]);
  await f.settle(fourth);

  const fifth = await f.claim();
  expect(await f.govern(fifth, null)).toBeNull();
  expect(await f.governed()).toEqual(["Rule A", "Rule B", WORKSPACE_GOVERNANCE_NONE]);
}, 180_000);

test("message forks keep governance history items", async () => {
  const f = await fixture(true);
  const first = await f.claim();
  expect(await f.govern(first, "Rule A")).toBe("Rule A");
  await f.settle(first);
  const second = await f.claim();
  expect(await f.govern(second, "Rule B")).toBe("Rule B");
  await f.settle(second);
  const fork = await forkSessionContent(client.db, {
    sourceWorkspaceId: f.workspaceId,
    sourceSessionId: f.sessionId,
    actorSubjectId: f.subjectId,
    destinationWorkspaceId: f.workspaceId,
    destinationVisibility: "user_private",
    workspaceSharedAcknowledged: false,
    operationKey: `fork-${crypto.randomUUID()}`,
    sourceEventId: second.triggerEventId,
  });
  const copied = await getActiveSessionHistoryItems(client.db, f.workspaceId, fork.sessionId);
  expect(
    copied.map((row) => readWorkspaceGovernanceContext(row.item)).filter((value) => value !== null),
  ).toContain("Rule A");
}, 180_000);
