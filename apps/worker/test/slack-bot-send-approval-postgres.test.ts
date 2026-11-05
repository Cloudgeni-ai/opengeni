import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acceptSessionApprovalDecision,
  applySessionTurnSettlement,
  beginConnectorActionExecution,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  completeConnectorActionExecution,
  createDb,
  createSession,
  getSessionChainRoot,
  prepareConnectorActionApproval,
  resolveAttemptConnectorToolDecision,
  saveRunState,
  submitHumanPromptInTransaction,
  upsertConnectorActionPolicy,
  withWorkspaceSubjectSessionActivityRls,
  type ConnectorActionAttemptIdentity,
} from "@opengeni/db";
import { scheduledTurnMcpServerIds } from "@opengeni/core";
import { sessionMcpApprovalConnectionId, type ConnectorActionToolCall } from "@opengeni/runtime";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";

import {
  PERSONAL_SLACK_SEND_TOOL_NAME,
  slackBotSendHasPerson,
  strictestDecision,
  withSlackBotSendApproval,
} from "../src/activities/agent-turn/slack-bot-send-approval";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(120_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("slack-bot-send-approval");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const SLACK_SERVER_ID = "slack-personal";

/** A claimed interactive attempt, with the person's Slack send permission set first when given. */
async function claimedAttempt(personalSend: "ask" | "allow" | "block" | null) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Bot send approval",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Bot send approval",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "post the launch update",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    grant.workspaceId!,
    grant.subjectId,
    (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          subjectId: grant.subjectId,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: `send-${crypto.randomUUID()}`,
          delivery: "send",
          text: "post the launch update to #halcyon-launch",
          resources: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
  );
  const personalSlackConnectionId = crypto.randomUUID();
  // What the Slack connection's tool permissions save for its change tools.
  if (personalSend)
    await upsertConnectorActionPolicy(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      subjectId: grant.subjectId,
      connectionId: personalSlackConnectionId,
      serverId: SLACK_SERVER_ID,
      toolName: PERSONAL_SLACK_SEND_TOOL_NAME,
      actionName: "*",
      policy: personalSend,
    });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`claim failed: ${claim.reason}`);
  const identity: ConnectorActionAttemptIdentity = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    turnId: claim.turn.id,
    attemptId,
    executionGeneration: claim.turn.executionGeneration,
    initiator: claim.turn.initiator,
  };
  return { identity, personalSlackConnectionId, grant, session, claim };
}

/** The worker's connector hooks for this attempt, as the turn wires them, over the real ledger. */
function hooksFor(
  identity: ConnectorActionAttemptIdentity,
  personalSlackConnectionId: string,
  interactive = true,
) {
  return withSlackBotSendApproval(
    {
      prepare: async (call) => await prepareConnectorActionApproval(client.db, identity, call),
      begin: async (call) => await beginConnectorActionExecution(client.db, identity, call),
      complete: async ({ requestId, outcome }) =>
        await completeConnectorActionExecution(client.db, {
          accountId: identity.accountId,
          workspaceId: identity.workspaceId,
          requestId,
          attemptId: identity.attemptId,
          outcome,
        }),
    },
    {
      interactive,
      personalSlackSendDecision: async () =>
        strictestDecision([
          await resolveAttemptConnectorToolDecision(client.db, identity, {
            connectionId: personalSlackConnectionId,
            serverId: SLACK_SERVER_ID,
            toolName: PERSONAL_SLACK_SEND_TOOL_NAME,
            defaultDecision: "allow",
          }),
        ]),
    },
  );
}

/** Pause the turn on the call's approval and record the person's decision, as the chat does. */
async function decideAndResume(
  attempt: Awaited<ReturnType<typeof claimedAttempt>>,
  approvalId: string,
  decision: "approve" | "reject",
): Promise<ConnectorActionAttemptIdentity> {
  const { identity, grant, session, claim } = attempt;
  expect(
    await saveRunState(client.db, {
      accountId: identity.accountId,
      workspaceId: identity.workspaceId,
      sessionId: session.id,
      turnId: identity.turnId,
      expectedExecutionGeneration: identity.executionGeneration,
      expectedAttemptId: identity.attemptId,
      serializedRunState: JSON.stringify({ history: [], fixture: "bot-send-approval" }),
      pendingApprovals: [{ id: approvalId }],
    }),
  ).toBe(true);
  await applySessionTurnSettlement(client.db, identity.workspaceId, {
    sessionId: session.id,
    turnId: identity.turnId,
    triggerEventId: claim.turn.triggerEventId,
    attemptId: identity.attemptId,
    turnStatus: "requires_action",
    sessionStatus: "requires_action",
    activeTurnId: identity.turnId,
    events: [{ type: "session.requiresAction", payload: { approvalId } }],
  });
  const accepted = await acceptSessionApprovalDecision(client.db, {
    accountId: identity.accountId,
    workspaceId: identity.workspaceId,
    sessionId: session.id,
    subjectId: grant.subjectId,
    payload: { approvalId, decision },
    decidedBySignedInPerson: true,
    clientEventId: crypto.randomUUID(),
  });
  if (accepted.action !== "accepted") throw new Error("decision was not accepted");
  const attemptId = crypto.randomUUID();
  const resumed = await claimSessionWorkForAttempt(client.db, identity.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "approval", triggerEventId: accepted.event.id },
  });
  if (resumed.action !== "claimed") throw new Error(`resume failed: ${resumed.reason}`);
  return {
    ...identity,
    attemptId,
    executionGeneration: resumed.turn.executionGeneration,
    initiator: resumed.turn.initiator,
  };
}

function botSend(approvalId = crypto.randomUUID()): ConnectorActionToolCall {
  return {
    approvalId,
    connectionId: sessionMcpApprovalConnectionId("opengeni", "http://127.0.0.1:8000/v1/mcp"),
    serverId: "opengeni",
    toolName: "slack_bot_send_prepared_message",
    arguments: { messageId: crypto.randomUUID() },
    approvalMode: "session_mcp",
    defaultDecision: "ask",
  };
}

describe("a bot send follows the person's Slack send permission", () => {
  test("Ask first on the person's Slack sends opens an approval request for the bot send", async () => {
    const { identity, personalSlackConnectionId } = await claimedAttempt("ask");
    expect(
      await resolveAttemptConnectorToolDecision(client.db, identity, {
        connectionId: personalSlackConnectionId,
        serverId: SLACK_SERVER_ID,
        toolName: PERSONAL_SLACK_SEND_TOOL_NAME,
        defaultDecision: "allow",
      }),
    ).toBe("ask");
    const prepared = await hooksFor(identity, personalSlackConnectionId).prepare(botSend());
    expect(prepared).toMatchObject({ managed: true, decision: "ask", approvalStatus: "pending" });
    expect((prepared as { requestId?: string }).requestId).toEqual(expect.any(String));
  });

  test("without a chosen permission the bot send runs at once, as before", async () => {
    for (const personalSend of [null, "allow"] as const) {
      const { identity, personalSlackConnectionId } = await claimedAttempt(personalSend);
      const prepared = await hooksFor(identity, personalSlackConnectionId).prepare(botSend());
      expect(prepared).toMatchObject({ managed: true, decision: "allow" });
      expect((prepared as { requestId?: string }).requestId).toBeUndefined();
    }
  });

  test("a scheduled or unattended run keeps sending at once under Ask first", async () => {
    const { identity, personalSlackConnectionId } = await claimedAttempt("ask");
    const prepared = await hooksFor(identity, personalSlackConnectionId, false).prepare(botSend());
    expect(prepared).toMatchObject({ managed: true, decision: "allow" });
  });

  test("approved, the resumed attempt sends once, and a retry is refused", async () => {
    const attempt = await claimedAttempt("ask");
    const call = botSend();
    const first = hooksFor(attempt.identity, attempt.personalSlackConnectionId);
    expect(await first.prepare(call)).toMatchObject({ decision: "ask", approvalStatus: "pending" });
    // Undecided, it cannot run.
    expect(await first.begin(call)).toMatchObject({
      allowed: false,
      reason: "approval_required",
    });

    const resumedIdentity = await decideAndResume(attempt, call.approvalId, "approve");
    // The fresh attempt decides afresh from its own snapshot and gets the same call.
    const resumed = hooksFor(resumedIdentity, attempt.personalSlackConnectionId);
    const admission = await resumed.begin(call);
    expect(admission).toMatchObject({ allowed: true, managed: true });
    if (!admission.allowed || !admission.managed) throw new Error("approved send was refused");
    await resumed.complete({ requestId: admission.requestId, outcome: "completed" });
    expect(await resumed.begin(call)).toMatchObject({
      allowed: false,
      reason: "already_executed",
    });
  });

  test("rejected, the bot send is denied", async () => {
    const attempt = await claimedAttempt("ask");
    const call = botSend();
    await hooksFor(attempt.identity, attempt.personalSlackConnectionId).prepare(call);
    const resumedIdentity = await decideAndResume(attempt, call.approvalId, "reject");
    expect(
      await hooksFor(resumedIdentity, attempt.personalSlackConnectionId).begin(call),
    ).toMatchObject({ allowed: false, reason: "rejected" });
  });

  test("Block on the person's Slack sends blocks the bot send", async () => {
    const { identity, personalSlackConnectionId } = await claimedAttempt("block");
    const hooks = hooksFor(identity, personalSlackConnectionId);
    const call = botSend();
    expect(await hooks.prepare(call)).toEqual({ managed: true, decision: "block" });
    expect(await hooks.begin(call)).toMatchObject({ allowed: false, reason: "blocked" });
  });

  test("a worker asks like its root chat: attended asks, scheduled or unattended does not", async () => {
    const attempt = await claimedAttempt("ask");
    const { identity, grant } = attempt;
    const worker = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      parentSessionId: identity.sessionId,
      createdByActor: {
        type: "agent_attempt",
        sessionId: identity.sessionId,
        turnId: identity.turnId,
        attemptId: identity.attemptId,
        executionGeneration: identity.executionGeneration,
      },
      initialMessage: "post the launch update",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
    } as never);
    const hasPerson = async () =>
      await slackBotSendHasPerson({
        scheduled: false,
        unattended: false,
        chainRoot: async () => {
          const root = await getSessionChainRoot(client.db, grant.workspaceId!, worker.id);
          return root
            ? {
                rootUnattended: root.rootUnattended,
                rootTurnScheduled:
                  root.rootTurnMetadata !== null &&
                  scheduledTurnMcpServerIds({ metadata: root.rootTurnMetadata }) !== null,
              }
            : null;
        },
      });
    expect(await getSessionChainRoot(client.db, grant.workspaceId!, identity.sessionId)).toBeNull();
    expect(await getSessionChainRoot(client.db, grant.workspaceId!, worker.id)).toMatchObject({
      rootSessionId: identity.sessionId,
      rootUnattended: false,
    });
    // Spawning a worker from an attended chat is no way around the approval.
    expect(await hasPerson()).toBe(true);

    // The root turn that spawned it was a scheduled run.
    await shared.admin`
      update session_turns
      set metadata = metadata || jsonb_build_object('scheduledEffectiveMcpServerIds', '[]'::jsonb)
      where id = ${identity.turnId}`;
    expect(await hasPerson()).toBe(false);
    await shared.admin`
      update session_turns set metadata = metadata - 'scheduledEffectiveMcpServerIds'
      where id = ${identity.turnId}`;
    expect(await hasPerson()).toBe(true);

    // The root chat runs without a person.
    await shared.admin`
      update sessions set unattended_setting = 'unattended' where id = ${identity.sessionId}`;
    expect(await hasPerson()).toBe(false);
  });
});
