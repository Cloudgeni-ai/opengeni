import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  SessionControlConflictError,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionGoal,
  getSessionTurnForAttempt,
  initializeSessionStartAtomically,
  listSessionGoalRevisions,
  recoverSessionDispatch,
  rejectSessionGoalRevisionWithEvent,
  updateSessionGoalWithEvent,
  upsertSessionGoalWithEvent,
  dbSql,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("goal-revision-control");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(
  options: {
    mutationPolicy?: "review_changes" | "preserve_intent" | "autonomous_adaptation";
    rootConstraints?: string[];
  } = {},
) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "goal-revision-control",
    accountExternalId: `account-${suffix}`,
    accountName: "Goal revision control",
    workspaceExternalSource: "goal-revision-control",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Goal revision control",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "start",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    clientEventId: `initial:${session.id}`,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: {
      text: "Initial objective",
      mutationPolicy: options.mutationPolicy ?? "preserve_intent",
      rootConstraints: options.rootConstraints ?? [],
    },
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("fixture turn was not claimed");
  return { grant, session, attemptId, turn: claimed.turn };
}

function command(ctx: Awaited<ReturnType<typeof fixture>>, operationKey = crypto.randomUUID()) {
  return {
    accountId: ctx.grant.accountId,
    actor: {
      type: "agent_attempt" as const,
      sessionId: ctx.session.id,
      turnId: ctx.turn.id,
      attemptId: ctx.attemptId,
      executionGeneration: ctx.turn.executionGeneration,
    },
    operationKey,
  };
}

describe("goal revision decisions", () => {
  test("agent semantic rewrites require classification, rationale, and an exact revision fence", async () => {
    const ctx = await fixture({ rootConstraints: ["human-owned constraint"] });
    await expect(
      updateSessionGoalWithEvent(client.db, ctx.grant.workspaceId, ctx.session.id, {
        text: "Unclassified rewrite",
        actor: "agent",
        command: command(ctx),
      }),
    ).rejects.toThrow("requires changeKind, rationale, and expectedObjectiveRevision");
    expect((await getSessionGoal(client.db, ctx.grant.workspaceId, ctx.session.id))?.text).toBe(
      "Initial objective",
    );
    await expect(
      upsertSessionGoalWithEvent(client.db, {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.grant.workspaceId,
        sessionId: ctx.session.id,
        text: "Agent must not remove the root constraint",
        rootConstraints: [],
        createdBy: "agent",
        actor: "agent",
      }),
    ).rejects.toThrow("agent goal mutations cannot change root constraints");
  });

  test("proposal rejection is immutable, replayable, and mutually exclusive with apply", async () => {
    const ctx = await fixture({ mutationPolicy: "review_changes" });
    const proposed = await updateSessionGoalWithEvent(
      client.db,
      ctx.grant.workspaceId,
      ctx.session.id,
      {
        text: "Materially different objective",
        changeKind: "replacement",
        rationale: "new evidence suggests replacing the objective",
        expectedObjectiveRevision: 1,
        actor: "agent",
        command: command(ctx),
      },
    );
    if (!proposed.proposalId) throw new Error("proposal was not created");
    const rejected = await rejectSessionGoalRevisionWithEvent(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId,
      sessionId: ctx.session.id,
      revisionId: proposed.proposalId,
      expectedObjectiveRevision: 1,
      rationale: "keep the original user objective",
    });
    expect(rejected).toMatchObject({
      replay: false,
      revision: { disposition: "rejected", proposalId: proposed.proposalId },
    });
    const replay = await rejectSessionGoalRevisionWithEvent(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId,
      sessionId: ctx.session.id,
      revisionId: proposed.proposalId,
      expectedObjectiveRevision: 1,
      rationale: "keep the original user objective",
    });
    expect(replay).toMatchObject({ replay: true, events: [] });
    await expect(
      upsertSessionGoalWithEvent(client.db, {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.grant.workspaceId,
        sessionId: ctx.session.id,
        text: "Materially different objective",
        mutationPolicy: "review_changes",
        expectedObjectiveRevision: 1,
        expectedGoalId: proposed.goal.id,
        changeKind: "replacement",
        changeRationale: "attempt to apply a rejected proposal",
        sourceProposalId: proposed.proposalId,
        createdBy: "api",
        actor: "api",
      }),
    ).rejects.toThrow("already decided");
    const history = await listSessionGoalRevisions(
      client.db,
      ctx.grant.workspaceId,
      ctx.session.id,
      { limit: 10 },
    );
    expect(history.revisions.map((revision) => revision.disposition)).toEqual([
      "rejected",
      "proposed",
      "applied",
    ]);
  });

  test("rollback creates a new applied revision under CAS and concurrent stale work loses", async () => {
    const ctx = await fixture({ rootConstraints: ["beta", " alpha ", "beta"] });
    expect(ctx.turn.goalSnapshot).toMatchObject({
      state: "active",
      rootConstraints: ["alpha", "beta"],
    });
    const redirected = await upsertSessionGoalWithEvent(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId,
      sessionId: ctx.session.id,
      text: "Second objective",
      rootConstraints: ["beta"],
      mutationPolicy: "preserve_intent",
      expectedObjectiveRevision: 1,
      changeKind: "replacement",
      changeRationale: "direct user redirect",
      createdBy: "api",
      actor: "api",
    });
    const page = await listSessionGoalRevisions(client.db, ctx.grant.workspaceId, ctx.session.id, {
      limit: 10,
    });
    const initial = page.revisions.find((revision) => revision.resultObjectiveRevision === 1);
    if (!initial) throw new Error("initial applied revision missing");
    const rollback = () =>
      upsertSessionGoalWithEvent(client.db, {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.grant.workspaceId,
        sessionId: ctx.session.id,
        text: initial.text,
        successCriteria: initial.successCriteria,
        rootConstraints: initial.rootConstraints,
        mutationPolicy: initial.mutationPolicy,
        expectedObjectiveRevision: redirected.goal.objectiveRevision,
        expectedGoalId: initial.goalId,
        changeKind: "replacement",
        changeRationale: "undo the direct redirect",
        rollbackOfRevisionId: initial.id,
        createdBy: "api" as const,
        actor: "api" as const,
      });
    const settled = await Promise.allSettled([rollback(), rollback()]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    const current = await getSessionGoal(client.db, ctx.grant.workspaceId, ctx.session.id);
    expect(current).toMatchObject({
      text: "Initial objective",
      rootConstraints: ["alpha", "beta"],
      objectiveRevision: 3,
    });
    const after = await listSessionGoalRevisions(client.db, ctx.grant.workspaceId, ctx.session.id, {
      limit: 10,
    });
    expect(after.revisions).toContainEqual(
      expect.objectContaining({
        disposition: "applied",
        resultObjectiveRevision: 3,
        rollbackOfRevisionId: initial.id,
      }),
    );
  });

  test("Postgres rejects a multibyte root constraint beyond the canonical byte cap", async () => {
    let failure: unknown;
    try {
      await Promise.resolve(
        client.db.execute(
          dbSql`select session_goal_normalize_root_constraints(
          ${JSON.stringify(["é".repeat(257)])}::jsonb
        )`,
        ),
      );
    } catch (error) {
      failure = error;
    }
    expect((failure as { cause?: Error }).cause?.message).toContain("exceeds 512 UTF-8 bytes");
  });

  test("accepted root constraints survive recovery while bounded history paginates without overlap", async () => {
    const ctx = await fixture({ rootConstraints: ["frozen constraint"] });
    await upsertSessionGoalWithEvent(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId,
      sessionId: ctx.session.id,
      text: "Changed after acceptance",
      rootConstraints: ["later constraint"],
      expectedObjectiveRevision: 1,
      changeKind: "replacement",
      changeRationale: "direct user redirect after turn acceptance",
      createdBy: "api",
      actor: "api",
    });
    const recovered = await recoverSessionDispatch(client.db, ctx.grant.workspaceId, {
      sessionId: ctx.session.id,
      attemptId: ctx.attemptId,
      timeoutType: "HEARTBEAT",
      maxRedispatches: 3,
    });
    expect(recovered.action).toBe("recovering");
    const replacementAttemptId = crypto.randomUUID();
    const replacement = await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId, {
      sessionId: ctx.session.id,
      workflowId: `session-${ctx.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: replacementAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (replacement.action !== "claimed") throw new Error("recovery was not claimed");
    expect(replacement.turn.goalSnapshot).toMatchObject({
      rootConstraints: ["frozen constraint"],
      objectiveRevision: 1,
    });

    await upsertSessionGoalWithEvent(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId,
      sessionId: ctx.session.id,
      text: "Third objective",
      expectedObjectiveRevision: 2,
      changeKind: "replacement",
      changeRationale: "create pagination evidence",
      createdBy: "api",
      actor: "api",
    });
    const first = await listSessionGoalRevisions(client.db, ctx.grant.workspaceId, ctx.session.id, {
      limit: 2,
    });
    expect(first).toMatchObject({ hasMore: true });
    expect(first.revisions).toHaveLength(2);
    if (!first.nextCursor) throw new Error("next revision cursor missing");
    const second = await listSessionGoalRevisions(
      client.db,
      ctx.grant.workspaceId,
      ctx.session.id,
      { limit: 2, before: first.nextCursor },
    );
    expect(second.revisions).toHaveLength(1);
    expect(
      first.revisions.some((revision) =>
        second.revisions.some((candidate) => candidate.id === revision.id),
      ),
    ).toBe(false);

    const other = await fixture();
    expect(
      await getSessionTurnForAttempt(
        client.db,
        ctx.grant.workspaceId,
        crypto.randomUUID(),
        replacementAttemptId,
      ),
    ).toBeNull();
    expect(
      await getSessionTurnForAttempt(
        client.db,
        other.grant.workspaceId,
        other.session.id,
        replacementAttemptId,
      ),
    ).toBeNull();
    await expect(
      listSessionGoalRevisions(client.db, ctx.grant.workspaceId, ctx.session.id, {
        limit: 2,
        before: (
          await listSessionGoalRevisions(client.db, other.grant.workspaceId, other.session.id, {
            limit: 1,
          })
        ).revisions[0]!.id,
      }),
    ).rejects.toBeInstanceOf(SessionControlConflictError);
  }, 20_000);
});
