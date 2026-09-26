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
  getSessionHistoryItems,
  initializeSessionStartAtomically,
  listOutstandingSessionSystemUpdates,
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
  input: { message: string; parent?: Awaited<ReturnType<typeof startSession>> },
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
    goal: null,
  });
  return { session, ...(await claim(grant, session.id)) };
}

type Started = Awaited<ReturnType<typeof startSession>>;

async function completeTurn(grant: Grant, started: Started, output: string): Promise<void> {
  const settled = await applySessionTurnSettlement(client.db, grant.workspaceId, {
    sessionId: started.session.id,
    turnId: started.turn.id,
    triggerEventId: started.turn.triggerEventId,
    attemptId: started.attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [
      { type: "agent.message.completed" as const, payload: { text: output } },
      { type: "turn.completed" as const, payload: { output } },
    ],
  });
  expect(settled.action).toBe("settled");
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
  await enqueueSessionTurn(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: parent.session.id,
    triggerEventId: crypto.randomUUID(),
    temporalWorkflowId: `session-${parent.session.id}`,
    source: "user",
    prompt: "what did the worker find?",
    resources: [],
    tools: [],
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    metadata: {},
    initiator: { kind: "subject", subjectId: grant.subjectId },
  });
  await claim(grant, parent.session.id);
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
});
