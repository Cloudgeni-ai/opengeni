import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  acceptSessionApprovalDecision,
  bootstrapWorkspace,
  createDb,
  createSession,
  getActiveSessionHistoryItemsPaged,
  getSession,
  getToolActionReview,
  initializeSessionStartAtomically,
  listInboxItems,
  listSessionEvents,
  SessionApprovalAnswerError,
  upsertConnectorActionPolicy,
} from "@opengeni/db";
import {
  createProductionAgentRuntime,
  prefixedMcpToolName,
  sessionMcpApprovalConnectionId,
  type OpenGeniRuntime,
} from "@opengeni/runtime";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import {
  FakeMcpElicitationServer,
  startFakeMcpElicitationServer,
} from "@opengeni/testing/mcp-elicitation-server";
import { ScriptedModel, assistantMessage, functionCall } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { createActivityTestHarness } from "../src/activities";

// An MCP server asks the person mid-call (MCP elicitation, multi round trip:
// forms, confirmations and pages to open) through the real worker turn path:
// real PostgreSQL in the production posture, the real SDK call flow over an
// offline ScriptedModel, and a real MCP server over HTTP. Every answer comes
// in a later attempt, as it would hours later in an unattended run.
setDefaultTimeout(120_000);
let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
let fake: FakeMcpElicitationServer;

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("mcp-elicitation-worker");
  if (!acquired) throw new Error("Native PostgreSQL required for MCP elicitation tests");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
  fake = startFakeMcpElicitationServer({ trustedChats: ["family"] });
}, 600_000);

afterAll(async () => {
  await fake?.stop();
  await app?.close();
  await shared?.release();
}, 60_000);

const SEND = prefixedMcpToolName("chat", "send_message");
const BOOK = prefixedMcpToolName("chat", "book_meeting");
const SIGN_IN = prefixedMcpToolName("chat", "sign_in");

async function startSession(message: string) {
  const subjectId = `user:mcp-elicitation:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "mcp-elicitation",
    accountExternalId: crypto.randomUUID(),
    accountName: "MCP elicitation",
    workspaceExternalSource: "mcp-elicitation",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "MCP elicitation",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const ctx = { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId };
  const session = await createSession(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    createdBy: { kind: "subject", subjectId },
    initialMessage: message,
    resources: [],
    tools: [{ kind: "mcp", id: "chat" }],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
    goal: null,
  });
  return { ...ctx, sessionId: session.id };
}
type Ctx = Awaited<ReturnType<typeof startSession>>;

function scriptedRuntime(scripted: ScriptedModel): OpenGeniRuntime {
  const production = createProductionAgentRuntime({ model: scripted });
  return {
    ...production,
    configure: () => {},
    resolveTurnModel: () => ({
      provider: { id: "test-chat", label: "Offline", kind: "api-key", api: "chat", builtin: false },
      client: {} as NonNullable<ReturnType<OpenGeniRuntime["resolveTurnModel"]>>["client"],
      model: scripted,
      configured: {
        id: "scripted-model",
        label: "Offline",
        providerId: "test-chat",
        providerLabel: "Offline",
        api: "chat",
        contextWindowTokens: 250_000,
        effectiveContextWindowTokens: 250_000,
        autoCompactTokenLimit: 225_000,
        reasoningEffort: false,
        hostedWebSearch: false,
      },
    }),
  };
}

/** Each turn attempt gets a fresh harness, as a later worker would. */
async function runTurn(ctx: Ctx, scripted: ScriptedModel, triggerEventId?: string) {
  const activities = createActivityTestHarness({
    settings: testSettings({
      databaseUrl: shared.appUrl,
      openaiModel: "scripted-model",
      sandboxBackend: "none",
      webSearchEnabled: false,
      mcpServers: [{ id: "chat", name: "Chat", url: fake.url, cacheToolsList: false }],
    }),
    db: app.db,
    bus: new MemoryEventBus(),
    runtime: scriptedRuntime(scripted),
  });
  return await activities.runAgentTurn({
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId: ctx.sessionId,
    workflowId: `session-${ctx.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    trigger: triggerEventId ? { kind: "approval", triggerEventId } : { kind: "next" },
  });
}

async function events(ctx: Ctx) {
  return await listSessionEvents(app.db, ctx.workspaceId, ctx.sessionId, { after: 0, limit: 500 });
}

type Approval = {
  id: string;
  elicitation?: { server: string; requests: Array<{ id: string; message: string }> };
};

async function latestApprovals(ctx: Ctx): Promise<Approval[]> {
  const requested = (await events(ctx)).filter((event) => event.type === "session.requiresAction");
  return (requested.at(-1)?.payload as { approvals?: Approval[] } | undefined)?.approvals ?? [];
}

async function decide(
  ctx: Ctx,
  payload: {
    approvalId: string;
    decision: "approve" | "reject";
    content?: unknown;
    message?: string;
  },
) {
  const decision = await acceptSessionApprovalDecision(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId: ctx.sessionId,
    subjectId: ctx.subjectId,
    payload,
    clientEventId: crypto.randomUUID(),
  });
  if (decision.action !== "accepted") throw new Error(`decision ${decision.action}`);
  return decision.event;
}

async function toolOutputs(ctx: Ctx, callId: string): Promise<unknown[]> {
  return (await events(ctx))
    .filter(
      (event) =>
        event.type === "agent.toolCall.output" && (event.payload as { id?: string }).id === callId,
    )
    .map((event) => (event.payload as { output: unknown }).output);
}

/** An explicit rule for the chat server's tool, frozen into the next attempt's policy. */
async function setPolicy(ctx: Ctx, toolName: string, policy: "allow" | "ask") {
  await upsertConnectorActionPolicy(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    subjectId: ctx.subjectId,
    connectionId: sessionMcpApprovalConnectionId("chat", fake.url),
    serverId: "chat",
    toolName,
    actionName: toolName,
    policy,
  });
}

/** The call's execute-once ledger record and its audit trail. */
async function ledger(ctx: Ctx, callId: string) {
  const [row] = await shared.admin<
    Array<{ id: string; status: string; decision: string | null; input_round: number }>
  >`
    select id, status, decision, input_round from connector_action_requests
    where session_id = ${ctx.sessionId} and approval_id = ${callId}`;
  if (!row) return { row: undefined, audit: [] as string[], metadata: "" };
  const audit = await shared.admin<Array<{ action: string; metadata: string }>>`
    select action, metadata::text as metadata from audit_events
    where target_id = ${row.id} order by occurred_at, id`;
  return {
    row: { status: row.status, decision: row.decision, inputRound: row.input_round },
    audit: audit.map((entry) => entry.action),
    metadata: audit.map((entry) => entry.metadata).join("\n"),
  };
}

/** What the inbox and the tool review (Slack, dialogs, embedders) show for a paused call. */
async function surfaces(ctx: Ctx, callId: string) {
  const review = await getToolActionReview(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId: ctx.sessionId,
    approvalId: callId,
  });
  const inbox = await listInboxItems(app.db, {
    accountId: ctx.accountId,
    subjectId: ctx.subjectId,
  });
  const item = inbox.find(
    (entry) => entry.sessionId === ctx.sessionId && entry.sourceKey === callId,
  );
  return { question: review?.question, item };
}

/** Model history keeps every call paired with exactly one result. */
async function expectPairedHistory(ctx: Ctx) {
  const history = await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, ctx.sessionId);
  const items = history.map((row) => row.item as { type?: string; callId?: string });
  const calls = items.filter((item) => item.type === "function_call").map((item) => item.callId);
  const results = items
    .filter((item) => item.type === "function_call_result")
    .map((item) => item.callId);
  expect(results.sort()).toEqual(calls.sort());
  return JSON.stringify(items);
}

test("a send to a trusted chat goes straight through without a pause", async () => {
  const ctx = await startSession("Tell the family hi");
  const callId = `call-${ctx.sessionId}`;
  const sentBefore = fake.sent.length;
  const scripted = new ScriptedModel([
    { output: [functionCall(SEND, { chat: "family", text: "hi" }, callId)] },
    { output: [assistantMessage("Sent.")] },
  ]);
  expect((await runTurn(ctx, scripted)).status).toBe("idle");
  expect(fake.sent.slice(sentBefore)).toEqual([{ chat: "family", text: "hi" }]);
  expect((await events(ctx)).some((event) => event.type === "session.requiresAction")).toBe(false);
  // The model declared it can be asked, but the server did not need to.
  expect(fake.calls.findLast((call) => call.arguments.chat === "family")).toMatchObject({
    declaredElicitation: true,
  });
});

test("a question pauses the call and a later answer sends it exactly once", async () => {
  const ctx = await startSession("Tell the team hi");
  const callId = `call-${ctx.sessionId}`;
  const text = `hi ${ctx.sessionId}`;
  const scripted = new ScriptedModel([
    { output: [functionCall(SEND, { chat: "team", text }, callId)] },
    { output: [assistantMessage("Sent.")] },
  ]);
  expect((await runTurn(ctx, scripted)).status).toBe("requires_action");
  expect(fake.sent.filter((message) => message.text === text)).toEqual([]);
  const [approval] = await latestApprovals(ctx);
  expect(approval).toMatchObject({
    id: callId,
    elicitation: {
      server: "Chat",
      requests: [{ id: "confirm", message: `Send “${text}” to team?` }],
    },
  });
  expect(JSON.stringify(approval)).not.toContain("requestState");
  expect(await getSession(app.db, ctx.workspaceId, ctx.sessionId)).toMatchObject({
    status: "requires_action",
  });
  // The inbox and the tool review show the server's question, not the tool name.
  const waiting = await surfaces(ctx, callId);
  expect(waiting.question).toMatchObject({
    server: "Chat",
    requests: [{ id: "confirm", message: `Send “${text}” to team?` }],
  });
  expect(waiting.item).toMatchObject({
    kind: "approval",
    title: `Send “${text}” to team?`,
    serverQuestion: { server: "Chat", kind: "confirm" },
  });

  // A confirmation has no fields: a plain approval answers it.
  const decision = await decide(ctx, { approvalId: callId, decision: "approve" });
  expect(decision.payload).toMatchObject({ content: { confirm: {} } });
  // Answered: no open question and no open item.
  expect(await surfaces(ctx, callId)).toEqual({ question: undefined, item: undefined });
  expect((await runTurn(ctx, scripted, decision.id)).status).toBe("idle");
  expect(fake.sent.filter((message) => message.text === text)).toEqual([{ chat: "team", text }]);
  const retry = fake.calls.findLast((call) => call.arguments.text === text);
  expect(retry?.inputResponses).toEqual({ confirm: { action: "accept", content: {} } });
  expect(await toolOutputs(ctx, callId)).toHaveLength(1);
  const history = await expectPairedHistory(ctx);
  expect(history).toContain("Sent to team.");
  // The model saw the call's final result and never the question.
  expect(scripted.calls).toBe(2);
  expect(JSON.stringify(scripted.requests[1]?.input)).toContain("Sent to team.");
  expect(JSON.stringify(scripted.requests[1]?.input)).not.toContain("Send “");
});

test("a form is checked, then a second question in the same call is asked and answered", async () => {
  const ctx = await startSession("Book the planning meeting");
  const callId = `call-${ctx.sessionId}`;
  const topic = `Plan ${ctx.sessionId}`;
  const scripted = new ScriptedModel([
    { output: [functionCall(BOOK, { topic }, callId)] },
    { output: [assistantMessage("Booked.")] },
  ]);
  expect((await runTurn(ctx, scripted)).status).toBe("requires_action");
  expect((await latestApprovals(ctx))[0]?.elicitation?.requests[0]).toMatchObject({
    id: "details",
    message: `Who should come to “${topic}”, and when?`,
  });
  const form = await surfaces(ctx, callId);
  expect(form.question?.requests[0]?.requestedSchema.required).toEqual(["room", "attendees"]);
  expect(form.item).toMatchObject({
    title: `Who should come to “${topic}”, and when?`,
    serverQuestion: { server: "Chat", kind: "form" },
  });

  // A required field without a default must be answered; nothing is recorded.
  await expect(decide(ctx, { approvalId: callId, decision: "approve" })).rejects.toThrow(
    new SessionApprovalAnswerError("People is required"),
  );
  await expect(
    decide(ctx, {
      approvalId: callId,
      decision: "approve",
      content: { details: { attendees: 30 } },
    }),
  ).rejects.toThrow("People must be at most 20");
  const first = await decide(ctx, {
    approvalId: callId,
    decision: "approve",
    content: { details: { attendees: 3 } },
  });
  // The recorded answer includes the form's defaults.
  expect(first.payload).toMatchObject({ content: { details: { room: "small", attendees: 3 } } });
  expect((await runTurn(ctx, scripted, first.id)).status).toBe("requires_action");
  expect(fake.booked.filter((booking) => booking.topic === topic)).toEqual([]);
  const [again] = await latestApprovals(ctx);
  expect(again).toMatchObject({
    id: callId,
    elicitation: { requests: [{ id: "confirm", message: "Book small room for 3?" }] },
  });
  // The new question reopens the inbox item and replaces the review's question.
  const asked = await surfaces(ctx, callId);
  expect(asked.question?.requests.map((request) => request.id)).toEqual(["confirm"]);
  expect(asked.item).toMatchObject({
    title: "Book small room for 3?",
    serverQuestion: { server: "Chat", kind: "confirm" },
  });
  // The model was not asked anything in between.
  expect(scripted.calls).toBe(1);

  const second = await decide(ctx, { approvalId: callId, decision: "approve" });
  expect((await runTurn(ctx, scripted, second.id)).status).toBe("idle");
  expect(fake.booked.filter((booking) => booking.topic === topic)).toEqual([
    { topic, room: "small", attendees: 3 },
  ]);
  const calls = fake.callsTo("book_meeting").filter((call) => call.arguments.topic === topic);
  expect(calls.map((call) => Object.keys(call.inputResponses ?? {}))).toEqual([
    [],
    ["details"],
    ["confirm"],
  ]);
  expect(await toolOutputs(ctx, callId)).toHaveLength(1);
  expect(await expectPairedHistory(ctx)).toContain(`Booked “${topic}”.`);
  expect(scripted.calls).toBe(2);
});

test("declining tells the server, which finishes the call without sending", async () => {
  const ctx = await startSession("Tell the team bye");
  const callId = `call-${ctx.sessionId}`;
  const text = `bye ${ctx.sessionId}`;
  const scripted = new ScriptedModel([
    { output: [functionCall(SEND, { chat: "team", text }, callId)] },
    { output: [assistantMessage("Not sent.")] },
  ]);
  expect((await runTurn(ctx, scripted)).status).toBe("requires_action");
  // A decline carries no answer, even if one is sent.
  const decision = await decide(ctx, {
    approvalId: callId,
    decision: "reject",
    content: { confirm: {} },
  });
  expect(decision.payload).not.toHaveProperty("content");
  expect((await runTurn(ctx, scripted, decision.id)).status).toBe("idle");
  expect(fake.sent.filter((message) => message.text === text)).toEqual([]);
  // The retry carries the decline, so the server can clean up and answer.
  const calls = fake.calls.filter((call) => call.arguments.text === text);
  expect(calls.map((call) => call.inputResponses)).toEqual([
    undefined,
    { confirm: { action: "decline" } },
  ]);
  // The model sees the server's own result, then that the person declined.
  const outputs = await toolOutputs(ctx, callId);
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toEqual(expect.stringContaining("Not sent."));
  expect(outputs[0]).toEqual(expect.stringMatching(/\n\nThe person declined Chat's question\.$/u));
  expect(await expectPairedHistory(ctx)).toContain("The person declined Chat's question.");
  // An unmanaged tool keeps no ledger record.
  expect((await ledger(ctx, callId)).row).toBeUndefined();
});

test("declining with a message tells the model the person's words", async () => {
  const ctx = await startSession("Tell the team later");
  const callId = `call-${ctx.sessionId}`;
  const text = `later ${ctx.sessionId}`;
  const scripted = new ScriptedModel([
    { output: [functionCall(SEND, { chat: "team", text }, callId)] },
    { output: [assistantMessage("Okay.")] },
  ]);
  expect((await runTurn(ctx, scripted)).status).toBe("requires_action");
  const decision = await decide(ctx, {
    approvalId: callId,
    decision: "reject",
    message: "Not to the team, send it to me.",
  });
  expect((await runTurn(ctx, scripted, decision.id)).status).toBe("idle");
  expect(fake.sent.filter((message) => message.text === text)).toEqual([]);
  expect(await expectPairedHistory(ctx)).toContain(
    "The person declined Chat's question and said: Not to the team, send it to me.",
  );
});

test("a page to open is continued after the person finishes it there", async () => {
  const ctx = await startSession("Connect my work account");
  const callId = `call-${ctx.sessionId}`;
  const account = `work-${ctx.sessionId}`;
  const scripted = new ScriptedModel([
    { output: [functionCall(SIGN_IN, { account }, callId)] },
    { output: [assistantMessage("Connected.")] },
  ]);
  expect((await runTurn(ctx, scripted)).status).toBe("requires_action");
  // The call declared it can send the person to a page.
  expect(
    fake.callsTo("sign_in").findLast((call) => call.arguments.account === account),
  ).toMatchObject({
    declaredElicitation: true,
    declaredUrlElicitation: true,
  });
  const page = FakeMcpElicitationServer.signInUrl(account);
  const [approval] = await latestApprovals(ctx);
  expect(approval?.elicitation).toEqual({
    server: "Chat",
    requests: [
      { id: "signIn", mode: "url", message: `Sign in to ${account} to continue.`, url: page },
    ],
  });
  const waiting = await surfaces(ctx, callId);
  expect(waiting.item).toMatchObject({
    title: `Sign in to ${account} to continue.`,
    serverQuestion: { server: "Chat", kind: "url", url: page },
  });
  // A page has nothing to fill in.
  await expect(
    decide(ctx, { approvalId: callId, decision: "approve", content: { signIn: { code: "1" } } }),
  ).rejects.toThrow("Question signIn has nothing to fill in");

  // Continuing before the page is done: the server asks again, the model is not woken.
  const early = await decide(ctx, { approvalId: callId, decision: "approve" });
  expect((await runTurn(ctx, scripted, early.id)).status).toBe("requires_action");
  expect((await surfaces(ctx, callId)).item).toMatchObject({ serverQuestion: { kind: "url" } });
  expect(scripted.calls).toBe(1);

  fake.finishSignIn(account);
  const done = await decide(ctx, { approvalId: callId, decision: "approve" });
  expect((await runTurn(ctx, scripted, done.id)).status).toBe("idle");
  const calls = fake.callsTo("sign_in").filter((call) => call.arguments.account === account);
  expect(calls.map((call) => call.inputResponses)).toEqual([
    undefined,
    { signIn: { action: "accept" } },
    { signIn: { action: "accept" } },
  ]);
  expect(await toolOutputs(ctx, callId)).toHaveLength(1);
  expect(await expectPairedHistory(ctx)).toContain(`Signed in to ${account}.`);
  expect(scripted.calls).toBe(2);
});

test("declining a page tells the server", async () => {
  const ctx = await startSession("Connect my other account");
  const callId = `call-${ctx.sessionId}`;
  const account = `other-${ctx.sessionId}`;
  const scripted = new ScriptedModel([
    { output: [functionCall(SIGN_IN, { account }, callId)] },
    { output: [assistantMessage("Okay.")] },
  ]);
  expect((await runTurn(ctx, scripted)).status).toBe("requires_action");
  const decision = await decide(ctx, { approvalId: callId, decision: "reject" });
  expect((await runTurn(ctx, scripted, decision.id)).status).toBe("idle");
  expect(
    fake.callsTo("sign_in").findLast((call) => call.arguments.account === account)?.inputResponses,
  ).toEqual({ signIn: { action: "decline" } });
  const [output] = await toolOutputs(ctx, callId);
  expect(output).toEqual(expect.stringContaining("Not signed in."));
  expect(output).toEqual(expect.stringMatching(/\n\nThe person declined Chat's question\.$/u));
  await expectPairedHistory(ctx);
});

test("a tool set to Ask is approved, then its server's question is answered, and it runs once", async () => {
  const ctx = await startSession("Tell the team we ship today");
  await setPolicy(ctx, "send_message", "ask");
  const callId = `call-${ctx.sessionId}`;
  const text = `ship ${ctx.sessionId}`;
  const scripted = new ScriptedModel([
    { output: [functionCall(SEND, { chat: "team", text }, callId)] },
    { output: [assistantMessage("Sent.")] },
  ]);
  // Opengeni's own approval comes first: the server is not called yet.
  expect((await runTurn(ctx, scripted)).status).toBe("requires_action");
  expect((await latestApprovals(ctx))[0]).not.toHaveProperty("elicitation");
  expect(fake.calls.filter((call) => call.arguments.text === text)).toEqual([]);
  const allowed = await decide(ctx, { approvalId: callId, decision: "approve" });

  // Then the server asks its own question, as a new round of the same record.
  expect((await runTurn(ctx, scripted, allowed.id)).status).toBe("requires_action");
  expect((await latestApprovals(ctx))[0]?.elicitation?.requests[0]?.message).toBe(
    `Send “${text}” to team?`,
  );
  expect((await ledger(ctx, callId)).row).toEqual({
    status: "pending",
    decision: null,
    inputRound: 1,
  });
  const answered = await decide(ctx, { approvalId: callId, decision: "approve" });
  expect((await runTurn(ctx, scripted, answered.id)).status).toBe("idle");

  expect(fake.sent.filter((message) => message.text === text)).toEqual([{ chat: "team", text }]);
  expect(await toolOutputs(ctx, callId)).toHaveLength(1);
  expect(await expectPairedHistory(ctx)).toContain("Sent to team.");
  const { row, audit } = await ledger(ctx, callId);
  expect(row).toEqual({ status: "completed", decision: "approve", inputRound: 1 });
  expect(audit).toEqual([
    "connector.action.approval_requested",
    "connector.action.approval_decided",
    "connector.action.execution_started",
    "connector.action.approval_requested",
    "connector.action.approval_decided",
    "connector.action.execution_started",
    "connector.action.execution_completed",
  ]);
});

test("a managed tool's declined question is delivered to the server exactly once", async () => {
  const ctx = await startSession("Tell the team we slip");
  await setPolicy(ctx, "send_message", "allow");
  const callId = `call-${ctx.sessionId}`;
  const text = `slip ${ctx.sessionId}`;
  const scripted = new ScriptedModel([
    { output: [functionCall(SEND, { chat: "team", text }, callId)] },
    { output: [assistantMessage("Not sent.")] },
  ]);
  expect((await runTurn(ctx, scripted)).status).toBe("requires_action");
  expect((await ledger(ctx, callId)).row).toEqual({
    status: "pending",
    decision: null,
    inputRound: 1,
  });
  const declined = await decide(ctx, { approvalId: callId, decision: "reject" });
  expect((await runTurn(ctx, scripted, declined.id)).status).toBe("idle");
  const calls = fake.calls.filter((call) => call.arguments.text === text);
  expect(calls.map((call) => call.inputResponses)).toEqual([
    undefined,
    { confirm: { action: "decline" } },
  ]);
  expect(fake.sent.filter((message) => message.text === text)).toEqual([]);
  const { row, audit, metadata } = await ledger(ctx, callId);
  // The call completed after the server was told no; the decision stays a rejection.
  expect(row).toEqual({ status: "completed", decision: "reject", inputRound: 1 });
  expect(audit.filter((action) => action === "connector.action.execution_started")).toHaveLength(2);
  expect(metadata).toContain("decline_delivery");
});

test("an answer to a question the server did not ask is refused", async () => {
  const ctx = await startSession("Tell the team something");
  const callId = `call-${ctx.sessionId}`;
  const text = `x ${ctx.sessionId}`;
  const scripted = new ScriptedModel([
    { output: [functionCall(SEND, { chat: "team", text }, callId)] },
    { output: [assistantMessage("Done.")] },
  ]);
  expect((await runTurn(ctx, scripted)).status).toBe("requires_action");
  await expect(
    decide(ctx, { approvalId: callId, decision: "approve", content: { other: {} } }),
  ).rejects.toThrow("There is no question other to answer");
});

test("a state-only answer is retried at once, and the question after it pauses", async () => {
  const ctx = await startSession("Warm up");
  const callId = `call-${ctx.sessionId}`;
  const scripted = new ScriptedModel([
    { output: [functionCall(prefixedMcpToolName("chat", "warm_up"), {}, callId)] },
    { output: [assistantMessage("Warm.")] },
  ]);
  expect((await runTurn(ctx, scripted)).status).toBe("requires_action");
  const [approval] = await latestApprovals(ctx);
  expect(approval?.elicitation?.requests).toEqual([
    expect.objectContaining({ id: "go", message: "Go?" }),
  ]);
  const decision = await decide(ctx, { approvalId: callId, decision: "approve" });
  expect((await runTurn(ctx, scripted, decision.id)).status).toBe("idle");
  expect(await expectPairedHistory(ctx)).toContain("Warmed up.");
});
