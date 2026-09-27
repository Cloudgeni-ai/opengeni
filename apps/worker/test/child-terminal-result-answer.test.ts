import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  enqueueSessionTurn,
  getOrCreateSessionSystemUpdateOutbox,
  getSessionHistoryItems,
  getSessionSystemUpdateOutboxByDedupeKey,
  initializeSessionStartAtomically,
  listOutstandingSessionSystemUpdates,
  materializeGoalContinuation,
  setSessionGoalStatus,
  setSessionGoalStatusWithEvent,
  settleSessionIdleWithParentOutbox,
} from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import { notifyParentOfChildIdle, type NotifyServices } from "../src/activities/parent-wake";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(60_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("child-terminal-result-answer");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Grant = { accountId: string; workspaceId: string; subjectId: string };

async function workspace(): Promise<Grant> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "child-terminal-result-answer",
    accountExternalId: `account-${suffix}`,
    accountName: "Child terminal result answer",
    workspaceExternalSource: "child-terminal-result-answer",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Child terminal result answer",
    subjectId: `user:owner-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
}

async function claim(grant: Grant, sessionId: string) {
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`turn was not claimed: ${claimed.action}`);
  return { turn: claimed.turn, attemptId };
}

async function startSession(
  grant: Grant,
  input: { message: string; parent?: Awaited<ReturnType<typeof startSession>>; goal?: string },
) {
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    ...(input.parent
      ? {
          parentSessionId: input.parent.session.id,
          createdByActor: {
            type: "agent_attempt" as const,
            attemptId: input.parent.attemptId,
            sessionId: input.parent.session.id,
            turnId: input.parent.turn.id,
            executionGeneration: input.parent.turn.executionGeneration,
          },
        }
      : {}),
    initialMessage: input.message,
    resources: [],
    tools: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    clientEventId: `initial:${session.id}`,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: input.goal ? { text: input.goal, mutationPolicy: "preserve_intent" } : null,
  });
  return { session, ...(await claim(grant, session.id)) };
}

type Started = Awaited<ReturnType<typeof startSession>>;

async function completeTurn(grant: Grant, started: Started, output: string): Promise<void> {
  await settleTurn(grant, started, [
    { type: "agent.message.completed" as const, payload: { text: output } },
    { type: "turn.completed" as const, payload: { output } },
  ]);
}

async function settleTurn(
  grant: Grant,
  started: Started,
  events: Array<{
    type: "agent.message.completed" | "turn.completed";
    payload: Record<string, unknown>;
  }>,
): Promise<void> {
  const settled = await applySessionTurnSettlement(client.db, grant.workspaceId, {
    sessionId: started.session.id,
    turnId: started.turn.id,
    triggerEventId: started.turn.triggerEventId,
    attemptId: started.attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events,
  });
  expect(settled.action).toBe("settled");
}

/** A new message to an idle session, claimed as its next turn. */
async function nextTurn(grant: Grant, started: Started, prompt: string): Promise<Started> {
  await enqueueSessionTurn(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: started.session.id,
    triggerEventId: crypto.randomUUID(),
    temporalWorkflowId: `session-${started.session.id}`,
    source: "user",
    prompt,
    resources: [],
    tools: [],
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    metadata: {},
    initiator: { kind: "subject", subjectId: grant.subjectId },
  });
  return { session: started.session, ...(await claim(grant, started.session.id)) };
}

/** What the workflow does after a goal-owned child's turn settles while its
 * goal is still active: materialize the continuation and claim it as the
 * child's next turn, which ran only to continue the goal. */
async function goalContinuationTurn(grant: Grant, started: Started): Promise<Started> {
  const materialized = await materializeGoalContinuation(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: started.session.id,
    workflowId: `session-${started.session.id}`,
    defaultMaxAutoContinuations: null,
    budgetBlocked: null,
    policy: {
      model: "scripted-model",
      reasoningEffort: "low",
      latencyMode: "standard",
      tools: [],
      sandboxBackend: "none",
    },
    prompt: (goal, count) => `continue ${goal.text} (${count})`,
  });
  expect(materialized.action).toBe("continue");
  const next = { session: started.session, ...(await claim(grant, started.session.id)) };
  expect(next.turn.source).toBe("goal");
  return next;
}

/** The continuation confirms the goal (goal_complete) and ends with a remark. */
async function completeGoalInContinuation(
  grant: Grant,
  continuation: Started,
  remark: string,
): Promise<void> {
  await setSessionGoalStatus(client.db, grant.workspaceId, continuation.session.id, {
    status: "completed",
    evidence: "The answer was delivered in the previous response.",
  });
  if (remark.length === 0) {
    await settleTurn(grant, continuation, [{ type: "turn.completed", payload: { output: "" } }]);
  } else {
    await completeTurn(grant, continuation, remark);
  }
}

function notifyServices(): NotifyServices {
  const errors: unknown[] = [];
  return {
    db: client.db,
    bus: { publish: async () => undefined } as unknown as EventBus,
    settings: testSettings(),
    observability: {
      info: () => undefined,
      error: (_message: string, detail: unknown) => {
        errors.push(detail);
        throw new Error(`notify failed: ${JSON.stringify(detail)}`);
      },
    } as unknown as NotifyServices["observability"],
    wakeSessionWorkflow: null,
  };
}

/** What the worker's markSessionIdle activity does at a child's idle boundary. */
async function markChildIdle(grant: Grant, child: Started): Promise<void> {
  const settled = await settleSessionIdleWithParentOutbox(
    client.db,
    grant.workspaceId,
    child.session.id,
  );
  if (settled.action !== "settled" || !settled.notifyParent) {
    throw new Error("child idle boundary did not notify its parent");
  }
  await notifyParentOfChildIdle(
    notifyServices(),
    grant.workspaceId,
    child.session.id,
    settled.episodeKey,
  );
}

async function childAnswerSequence(childSessionId: string): Promise<number> {
  const [row] = await shared.admin<Array<{ sequence: number }>>`
    select max(sequence)::int as sequence from session_events
    where session_id = ${childSessionId} and type = 'turn.completed'`;
  return row!.sequence;
}

async function acknowledgedSequence(subjectId: string, sessionId: string): Promise<number | null> {
  const [row] = await shared.admin<Array<{ acknowledged_sequence: number }>>`
    select acknowledged_sequence from session_pins
    where subject_id = ${subjectId} and session_id = ${sessionId}`;
  return row?.acknowledged_sequence ?? null;
}

/** The exact durable model memory row the parent's next inference receives. */
async function claimedParentBatch(grant: Grant, parent: Started, childSessionId: string) {
  await completeTurn(grant, parent, "Delegated the work.");
  await nextTurn(grant, parent, "what did the worker find?");
  const history = await getSessionHistoryItems(client.db, grant.workspaceId, parent.session.id);
  const batch = history
    .map(({ item }) => item.content)
    .find(
      (content): content is string =>
        typeof content === "string" &&
        content.startsWith("[OpenGeni internal updates]") &&
        content.includes(childSessionId),
    );
  if (!batch) throw new Error("claimed child result missing from parent history");
  const rendered = JSON.parse(batch.slice(batch.indexOf("{"))) as {
    updates: Array<{ kind: string; payload: Record<string, unknown> }>;
  };
  const update = rendered.updates.find((candidate) => candidate.kind === "child_terminal_result");
  if (!update) throw new Error("child_terminal_result missing from the claimed batch");
  return update;
}

describe("child_terminal_result carries the child's final answer", () => {
  test("a finished child's answer reaches the parent's model input in the wake itself", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { message: "Count the active users." });
    const child = await startSession(grant, { message: "Query the replica.", parent });
    const answer = "There were 1,204 active users in the last 48 hours (source: replica).";
    await completeTurn(grant, child, answer);
    const sequence = await childAnswerSequence(child.session.id);

    await markChildIdle(grant, child);

    const [pending] = await listOutstandingSessionSystemUpdates(
      client.db,
      grant.workspaceId,
      parent.session.id,
    );
    expect(pending?.kind).toBe("child_terminal_result");
    expect(pending?.payload).toMatchObject({
      type: "child_terminal_result",
      childSessionId: child.session.id,
      status: "idle",
      finalAnswer: { sequence, text: answer, truncated: false },
    });

    const update = await claimedParentBatch(grant, parent, child.session.id);
    expect(update.payload.finalAnswer).toMatchObject({ sequence, text: answer, truncated: false });
    // The parent consumed the complete answer, so the initiating human's rail no
    // longer shows the child as unread even though no read tool was called.
    expect(await acknowledgedSequence(grant.subjectId, child.session.id)).toBeGreaterThanOrEqual(
      sequence,
    );
  });

  test("an oversized answer is bounded, UTF-8 safe, marked, and points at the full result", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { message: "Summarize the audit." });
    const child = await startSession(grant, { message: "Write the audit.", parent });
    const answer = `Audit start. ${"Résumé 😀 données ".repeat(1_200)}Audit conclusion: all clear.`;
    expect(Buffer.byteLength(answer)).toBeGreaterThan(16 * 1024);
    await completeTurn(grant, child, answer);
    const sequence = await childAnswerSequence(child.session.id);

    await markChildIdle(grant, child);

    const update = await claimedParentBatch(grant, parent, child.session.id);
    const finalAnswer = update.payload.finalAnswer as {
      sequence: number;
      text: string;
      truncated: boolean;
      totalBytes: number;
      nextAction?: { tool: string; arguments: Record<string, unknown> };
    };
    expect(finalAnswer.sequence).toBe(sequence);
    expect(finalAnswer.truncated).toBe(true);
    expect(finalAnswer.totalBytes).toBe(Buffer.byteLength(answer));
    expect(Buffer.byteLength(finalAnswer.text)).toBeLessThanOrEqual(8 * 1024);
    expect(finalAnswer.text).not.toContain("�");
    expect(finalAnswer.text.startsWith("Audit start.")).toBe(true);
    expect(finalAnswer.text.endsWith("Audit conclusion: all clear.")).toBe(true);
    expect(finalAnswer.text).toContain("bytes of the final answer omitted");
    expect(finalAnswer.nextAction).toEqual({
      tool: "session_events",
      arguments: { sessionId: child.session.id, view: "results", after: sequence - 1 },
    });
    // A truncated answer is not proof that the parent consumed the whole result.
    expect(await acknowledgedSequence(grant.subjectId, child.session.id)).toBeNull();
  });

  test("an older answer behind a newer unanswered turn is not reported as the result", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { message: "Check the deploy." });
    const child = await startSession(grant, { message: "Watch it.", parent });
    await completeTurn(grant, child, "The first deploy is green.");
    const [row] = await shared.admin<Array<{ last: number }>>`
      select max(sequence)::int as last from session_events where session_id = ${child.session.id}`;
    await shared.admin`
      insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
      values (${grant.accountId}, ${grant.workspaceId}, ${child.session.id}, ${row!.last + 1},
        'turn.superseded', '{}'::jsonb)`;

    await markChildIdle(grant, child);

    const [pending] = await listOutstandingSessionSystemUpdates(
      client.db,
      grant.workspaceId,
      parent.session.id,
    );
    expect(pending?.kind).toBe("child_terminal_result");
    expect(pending?.payload).not.toHaveProperty("finalAnswer");
  });

  test("a newer task that stopped at a segment limit reports no answer, not the older one", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { message: "Run both tasks." });
    const child = await startSession(grant, { message: "Task A.", parent });
    await completeTurn(grant, child, "Answer to task A.");
    const taskB = await nextTurn(grant, child, "Task B.");
    // What the worker settles when a goal-less turn exhausts its budget.
    await settleTurn(grant, taskB, [
      {
        type: "turn.completed",
        payload: { output: "", segmentLimit: "budget_exhausted", detail: "Budget exhausted." },
      },
    ]);

    await markChildIdle(grant, child);

    const [pending] = await listOutstandingSessionSystemUpdates(
      client.db,
      grant.workspaceId,
      parent.session.id,
    );
    expect(pending?.kind).toBe("child_terminal_result");
    expect(pending?.payload).not.toHaveProperty("finalAnswer");
  });

  test("enrichment never replaces the answer the idle settlement froze", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { message: "Find the owner." });
    const child = await startSession(grant, { message: "Look it up.", parent });
    const answer = "The owner is the platform team.";
    await completeTurn(grant, child, answer);
    const settled = await settleSessionIdleWithParentOutbox(
      client.db,
      grant.workspaceId,
      child.session.id,
    );
    if (settled.action !== "settled" || !settled.notifyParent) {
      throw new Error("child idle boundary did not notify its parent");
    }
    const dedupeKey = `child-completion:${child.session.id}:${settled.episodeKey}`;
    const committed = await getSessionSystemUpdateOutboxByDedupeKey(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      dedupeKey,
    });
    if (!committed) throw new Error("idle settlement committed no outbox row");
    expect(committed.payload).toHaveProperty("finalAnswer.text", answer);

    // An enrichment built without the committed content (a failed read of the
    // row, or an older enricher) adds its facts but keeps the frozen answer.
    const { id: _id, status: _status, ...row } = committed;
    const enriched = await getOrCreateSessionSystemUpdateOutbox(client.db, {
      ...row,
      payload: {
        type: "child_terminal_result",
        childSessionId: child.session.id,
        status: "idle",
        goal: { status: "complete", text: "Find the owner." },
      },
    });

    expect(enriched.payload).toMatchObject({
      finalAnswer: { text: answer, truncated: false },
      goal: { status: "complete" },
    });
  });

  test("a goal continuation that only confirms the goal keeps the child's answer", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { message: "Count the active users." });
    const child = await startSession(grant, {
      message: "Report the active users from the replica.",
      parent,
      goal: "Report the active users from the replica",
    });
    const answer = "28 distinct users submitted work in the 48-hour window (source: replica).";
    await completeTurn(grant, child, answer);
    const answerSequence = await childAnswerSequence(child.session.id);
    const continuation = await goalContinuationTurn(grant, child);
    const remark = "The goal is complete. A fresh read-only check confirmed the 28 users.";
    await completeGoalInContinuation(grant, continuation, remark);
    const remarkSequence = await childAnswerSequence(child.session.id);
    expect(remarkSequence).toBeGreaterThan(answerSequence);

    await markChildIdle(grant, child);

    const [pending] = await listOutstandingSessionSystemUpdates(
      client.db,
      grant.workspaceId,
      parent.session.id,
    );
    expect(pending?.kind).toBe("child_terminal_result");
    // The answer stays the result; the goal-continuation remark follows it.
    expect((pending?.payload as Record<string, unknown> | undefined)?.finalAnswer).toEqual({
      sequence: answerSequence,
      text: answer,
      truncated: false,
      totalBytes: Buffer.byteLength(answer),
      goalContinuations: [{ sequence: remarkSequence, text: remark }],
    });

    const update = await claimedParentBatch(grant, parent, child.session.id);
    expect(update.payload.finalAnswer).toMatchObject({
      sequence: answerSequence,
      text: answer,
      goalContinuations: [{ sequence: remarkSequence, text: remark }],
    });
    // Both parts are exact child content, so the parent consumed the whole result.
    expect(await acknowledgedSequence(grant.subjectId, child.session.id)).toBeGreaterThanOrEqual(
      remarkSequence,
    );
  });

  test("a goal continuation without output reports the answer alone", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { message: "Find the owner." });
    const child = await startSession(grant, {
      message: "Look up the owner.",
      parent,
      goal: "Look up the owner",
    });
    const answer = "The owner is the platform team.";
    await completeTurn(grant, child, answer);
    const answerSequence = await childAnswerSequence(child.session.id);
    await completeGoalInContinuation(grant, await goalContinuationTurn(grant, child), "");

    await markChildIdle(grant, child);

    const [pending] = await listOutstandingSessionSystemUpdates(
      client.db,
      grant.workspaceId,
      parent.session.id,
    );
    expect((pending?.payload as Record<string, unknown> | undefined)?.finalAnswer).toEqual({
      sequence: answerSequence,
      text: answer,
      truncated: false,
      totalBytes: Buffer.byteLength(answer),
    });
  });

  test("an answer and continuation remark that together exceed the bound keep the remark and point at both", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { message: "Write the audit." });
    const child = await startSession(grant, {
      message: "Audit every module.",
      parent,
      goal: "Audit every module",
    });
    // Each part fits alone; together they do not, and neither is cut.
    await completeTurn(grant, child, `Audit: ${"all controls pass. ".repeat(300)}`);
    const answerSequence = await childAnswerSequence(child.session.id);
    const remark = `The goal is complete. ${"A fresh check confirmed it. ".repeat(100)}`;
    await completeGoalInContinuation(grant, await goalContinuationTurn(grant, child), remark);
    const remarkSequence = await childAnswerSequence(child.session.id);

    await markChildIdle(grant, child);

    const [pending] = await listOutstandingSessionSystemUpdates(
      client.db,
      grant.workspaceId,
      parent.session.id,
    );
    const finalAnswer = (pending?.payload as { finalAnswer?: Record<string, unknown> } | undefined)
      ?.finalAnswer;
    expect(finalAnswer).toMatchObject({
      sequence: remarkSequence,
      truncated: true,
      omittedSequences: [answerSequence],
      nextAction: { arguments: { sessionId: child.session.id, after: answerSequence - 1 } },
    });
    expect(String(finalAnswer?.text)).toStartWith("[... ");
    expect(String(finalAnswer?.text)).toEndWith(`\n\n${remark}`);
  });

  test("a child that works across goal continuations reports its final report", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { message: "Audit the platform." });
    const child = await startSession(grant, {
      message: "Audit the platform and write a final report.",
      parent,
      goal: "Audit the platform and write a final report",
    });
    await completeTurn(grant, child, "Starting the audit. I will report when it is done.");
    const startSequence = await childAnswerSequence(child.session.id);
    const progressTurn = await goalContinuationTurn(grant, child);
    await completeTurn(grant, progressTurn, `Progress: ${"module checked. ".repeat(300)}`);
    const progressSequence = await childAnswerSequence(child.session.id);
    const report = `FINAL REPORT\n${"Every control passed review. ".repeat(130)}`;
    await completeGoalInContinuation(grant, await goalContinuationTurn(grant, child), report);
    const reportSequence = await childAnswerSequence(child.session.id);

    await markChildIdle(grant, child);

    const [pending] = await listOutstandingSessionSystemUpdates(
      client.db,
      grant.workspaceId,
      parent.session.id,
    );
    const finalAnswer = (pending?.payload as { finalAnswer?: Record<string, unknown> } | undefined)
      ?.finalAnswer;
    // The report is whole; the earlier turns are named, not dropped silently.
    expect(finalAnswer).toMatchObject({
      sequence: reportSequence,
      truncated: true,
      omittedSequences: [startSequence, progressSequence],
      nextAction: { arguments: { sessionId: child.session.id, after: startSequence - 1 } },
    });
    expect(String(finalAnswer?.text)).toEndWith(`\n\n${report}`);
  });

  test("a child whose window holds only goal continuations reports its newest answer", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { message: "Watch the migration." });
    const child = await startSession(grant, {
      message: "Watch the migration until it finishes.",
      parent,
      goal: "Watch the migration until it finishes",
    });
    await completeTurn(grant, child, "Watching the migration.");
    // More continuations than the walk inspects, so its start is not in view.
    for (let index = 0; index < 16; index += 1) {
      await completeTurn(grant, await goalContinuationTurn(grant, child), `Batch ${index} done.`);
    }
    const last = "The migration finished: 16 batches applied.";
    await completeGoalInContinuation(grant, await goalContinuationTurn(grant, child), last);
    const lastSequence = await childAnswerSequence(child.session.id);

    await markChildIdle(grant, child);

    const [pending] = await listOutstandingSessionSystemUpdates(
      client.db,
      grant.workspaceId,
      parent.session.id,
    );
    expect((pending?.payload as Record<string, unknown> | undefined)?.finalAnswer).toEqual({
      sequence: lastSequence,
      text: last,
      truncated: false,
      totalBytes: Buffer.byteLength(last),
    });
  });

  test("a resumed goal reports only the output after its resume", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { message: "Find the owner." });
    const child = await startSession(grant, {
      message: "Look up the owner.",
      parent,
      goal: "Look up the owner",
    });
    await completeTurn(grant, child, "The owner is the platform team.");
    // The child pauses its goal in a continuation; its first result reports both.
    const pausing = await goalContinuationTurn(grant, child);
    await setSessionGoalStatusWithEvent(client.db, grant.workspaceId, child.session.id, {
      status: "paused",
      pausedReason: "agent",
      event: { type: "goal.paused", actor: "agent", reason: "agent", rationale: "Waiting." },
    });
    await completeTurn(grant, pausing, "Pausing until the owner confirms.");
    await markChildIdle(grant, child);
    // An operator resumes the goal; the next continuation is a new run.
    await setSessionGoalStatusWithEvent(client.db, grant.workspaceId, child.session.id, {
      status: "active",
      event: { type: "goal.resumed", actor: "api" },
    });
    const resumed = "The owner confirmed: the platform team keeps it.";
    await completeGoalInContinuation(grant, await goalContinuationTurn(grant, child), resumed);
    const resumedSequence = await childAnswerSequence(child.session.id);

    await markChildIdle(grant, child);

    const results = await listOutstandingSessionSystemUpdates(
      client.db,
      grant.workspaceId,
      parent.session.id,
    );
    expect(results).toHaveLength(2);
    expect((results[1]?.payload as Record<string, unknown> | undefined)?.finalAnswer).toEqual({
      sequence: resumedSequence,
      text: resumed,
      truncated: false,
      totalBytes: Buffer.byteLength(resumed),
    });
  });
});
