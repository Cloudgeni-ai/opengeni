import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { capabilitySetupCompletedSummary } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  appendSessionEvents,
  appendSessionEventsForTurnAttempt,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  capabilitySetupContinuationDedupeKey,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  enqueueCapabilitySetupContinuation,
  initializeSessionStartAtomically,
  listSessionSystemUpdatesForTurn,
  peekSessionWork,
} from "../src/index";

// A person finishing setup from an agent's capability card wakes the agent
// once, in the person's own receiving context, so it continues the request
// that needed the capability without the person saying "done".

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(60_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("capability-setup-continuation");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Grant = { accountId: string; workspaceId: string; subjectId: string };

const CAPABILITY = { id: "mcp:mail", name: "Mail" } as const;

async function workspace(): Promise<Grant> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "capability-setup-continuation",
    accountExternalId: `account-${suffix}`,
    accountName: "Capability setup continuation",
    workspaceExternalSource: "capability-setup-continuation",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Capability setup continuation",
    subjectId: `subject-${suffix}`,
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

/** The worker's turn start: the person's request becomes the receiving context. */
async function markStarted(
  grant: Grant,
  sessionId: string,
  claimed: Awaited<ReturnType<typeof claim>>,
) {
  const started = await applySessionTurnSettlement(client.db, grant.workspaceId, {
    sessionId,
    turnId: claimed.turn.id,
    triggerEventId: claimed.turn.triggerEventId,
    attemptId: claimed.attemptId,
    turnStatus: "running",
    sessionStatus: "running",
    activeTurnId: claimed.turn.id,
    events: [{ type: "turn.started", payload: { turnId: claimed.turn.id } }],
  });
  expect(started.action).toBe("settled");
}

async function settleIdle(
  grant: Grant,
  sessionId: string,
  claimed: Awaited<ReturnType<typeof claim>>,
) {
  const settled = await applySessionTurnSettlement(client.db, grant.workspaceId, {
    sessionId,
    turnId: claimed.turn.id,
    triggerEventId: claimed.turn.triggerEventId,
    attemptId: claimed.attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: { reason: "test" } }],
  });
  expect(settled.action).toBe("settled");
}

/** "check my email": the agent posts a connect card for Mail and ends its turn. */
async function sessionWithCard(grant: Grant, options: { settle?: boolean } = {}) {
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "check my email",
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
  });
  const first = await claim(grant, session.id);
  await markStarted(grant, session.id, first);
  const appended = await appendSessionEventsForTurnAttempt(
    client.db,
    grant.workspaceId,
    session.id,
    first.turn.id,
    first.turn.executionGeneration,
    first.attemptId,
    [
      {
        type: "tool.auth_needed",
        payload: {
          serverId: "opengeni",
          toolName: "capability_authorization_request",
          providerDomain: "mail.example.com",
          reason: "missing_connection",
          capability: {
            id: CAPABILITY.id,
            name: CAPABILITY.name,
            kind: "mcp",
            source: "registry",
            action: "connect",
            rationale: "Reading your inbox needs Mail.",
            requiredVariables: [],
          },
        },
      },
    ],
  );
  const card = appended.events.find((event) => event.type === "tool.auth_needed");
  if (!card) throw new Error("the capability card was not appended");
  if (options.settle !== false) await settleIdle(grant, session.id, first);
  return { session, first, card };
}

function continueAfterSetup(
  grant: Grant,
  sessionId: string,
  requesterSubjectId?: string,
  toolsVerified = true,
) {
  return enqueueCapabilitySetupContinuation(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
    capabilityId: CAPABILITY.id,
    capabilityName: CAPABILITY.name,
    toolsVerified,
    requesterSubjectId: requesterSubjectId ?? grant.subjectId,
  });
}

describe("capability setup continuation", () => {
  test("wakes an idle session once and delivers the plain fact in a new turn", async () => {
    const grant = await workspace();
    const { session, first, card } = await sessionWithCard(grant);
    expect(await peekSessionWork(client.db, grant.workspaceId, session.id)).not.toEqual({
      kind: "runnable",
    });

    const queued = await continueAfterSetup(grant, session.id);
    if (queued.outcome !== "queued") throw new Error(`not queued: ${JSON.stringify(queued)}`);
    expect(queued.shouldWake).toBe(true);
    expect(queued.workflowWakeRevision).not.toBeNull();
    expect(queued.update).toMatchObject({
      kind: "capability_setup_completed",
      classification: "success",
      sourceId: card.id,
      dedupeKey: capabilitySetupContinuationDedupeKey(card.id),
      summary: capabilitySetupCompletedSummary(CAPABILITY.name, true),
      payload: {
        type: "capability_setup_completed",
        capabilityId: CAPABILITY.id,
        name: CAPABILITY.name,
        cardEventId: card.id,
      },
      lineage: { causalTurnId: first.turn.id },
    });
    expect(await peekSessionWork(client.db, grant.workspaceId, session.id)).toEqual({
      kind: "runnable",
    });

    // Repeats (another tab, a retry, the OAuth return and the card both
    // reporting) never add a second continuation for the same card.
    const repeated = await continueAfterSetup(grant, session.id);
    expect(repeated.outcome).toBe("already_queued");
    if (repeated.outcome !== "already_queued") throw new Error("unreachable");
    expect(repeated.update.id).toBe(queued.update.id);
    expect(repeated.shouldWake).toBe(false);

    // The wake starts a turn that carries the continuation.
    const resumed = await claim(grant, session.id);
    const delivered = await listSessionSystemUpdatesForTurn(
      client.db,
      grant.workspaceId,
      session.id,
      resumed.turn.id,
    );
    expect(delivered.map((update) => update.id)).toEqual([queued.update.id]);
    expect(delivered[0]?.summary).toBe(
      "The person finished setting up Mail from your request. Its tools are now available, so continue the request that needed it.",
    );
    // It runs as the person's own continuation, in their receiving context.
    const [authority] = await shared.admin<
      Array<{
        initiating_human_subject_id: string | null;
        execution_context_turn_id: string | null;
      }>
    >`
      select initiating_human_subject_id, execution_context_turn_id
      from session_turns where id = ${resumed.turn.id}`;
    expect(authority).toEqual({
      initiating_human_subject_id: grant.subjectId,
      execution_context_turn_id: first.turn.id,
    });
    await settleIdle(grant, session.id, resumed);

    // Still one per card after it was delivered.
    expect((await continueAfterSetup(grant, session.id)).outcome).toBe("already_queued");
  });

  test("unverified tools are not claimed available", async () => {
    const grant = await workspace();
    const { session } = await sessionWithCard(grant);
    const queued = await continueAfterSetup(grant, session.id, undefined, false);
    if (queued.outcome !== "queued") throw new Error(`not queued: ${JSON.stringify(queued)}`);
    expect(queued.update.summary).toBe(
      "The person finished setting up Mail from your request, so continue the request that needed it.",
    );
  });

  test("a continuation queued while the agent is still running is delivered after it", async () => {
    const grant = await workspace();
    const { session, first } = await sessionWithCard(grant, { settle: false });
    const queued = await continueAfterSetup(grant, session.id);
    expect(queued.outcome).toBe("queued");
    await settleIdle(grant, session.id, first);
    const resumed = await claim(grant, session.id);
    const delivered = await listSessionSystemUpdatesForTurn(
      client.db,
      grant.workspaceId,
      session.id,
      resumed.turn.id,
    );
    expect(delivered.map((update) => update.kind)).toEqual(["capability_setup_completed"]);
  });

  test("nothing is sent once the person has written after the card", async () => {
    const grant = await workspace();
    const { session } = await sessionWithCard(grant);
    await appendSessionEvents(client.db, grant.workspaceId, session.id, [
      { type: "user.message", payload: { text: "ok i did it" } },
    ]);
    expect(await continueAfterSetup(grant, session.id)).toEqual({
      outcome: "not_needed",
      reason: "later_message",
    });
  });

  test("nothing is sent without a card for that capability", async () => {
    const grant = await workspace();
    const { session } = await sessionWithCard(grant);
    expect(
      await enqueueCapabilitySetupContinuation(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        capabilityId: "mcp:calendar",
        capabilityName: "Calendar",
        toolsVerified: true,
        requesterSubjectId: grant.subjectId,
      }),
    ).toEqual({ outcome: "not_needed", reason: "no_card" });
  });

  test("someone other than the requester finishing setup sends nothing", async () => {
    const grant = await workspace();
    const { session } = await sessionWithCard(grant);
    expect(await continueAfterSetup(grant, session.id, `other-${crypto.randomUUID()}`)).toEqual({
      outcome: "not_needed",
      reason: "not_requester",
    });
  });
});
