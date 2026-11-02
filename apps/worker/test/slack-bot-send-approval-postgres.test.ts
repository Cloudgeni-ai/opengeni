import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  prepareConnectorActionApproval,
  resolveAttemptConnectorToolDecision,
  submitHumanPromptInTransaction,
  upsertConnectorActionPolicy,
  withWorkspaceSubjectSessionActivityRls,
  type ConnectorActionAttemptIdentity,
} from "@opengeni/db";
import { sessionMcpApprovalConnectionId, type ConnectorActionToolCall } from "@opengeni/runtime";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";

import {
  PERSONAL_SLACK_SEND_TOOL_NAME,
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
async function claimedAttempt(personalSend: "ask" | "allow" | null) {
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
  return { identity, personalSlackConnectionId };
}

/** The worker's connector hooks for this attempt, as the turn wires them. */
function hooksFor(
  identity: ConnectorActionAttemptIdentity,
  personalSlackConnectionId: string,
  interactive = true,
) {
  return withSlackBotSendApproval(
    {
      prepare: async (call) => await prepareConnectorActionApproval(client.db, identity, call),
      begin: async () => ({ allowed: true, managed: false }) as never,
      complete: async () => undefined,
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
});
