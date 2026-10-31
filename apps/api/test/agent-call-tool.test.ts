import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  ensureCanonicalHumanIdentityForAuthUser,
  getCanonicalHumanExactLoginBindingForAuthUser,
  getCanonicalHumanIdentityProjection,
  initializeSessionStartAtomically,
  listSessionEvents,
  registerNativePushDevice,
  synchronizeCanonicalHumanLoginBindings,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";

import { finishAgentCall } from "../src/agent-calls";
import { registerAgentCallTools } from "../src/mcp/agent-call-tools";

/* call_user rings the person's opted-in phones and waits for the outcome:
   nothing rings unless they allowed it, an answer or a decline from the phone
   returns at once, and a call nobody answers leaves a missed-call notice. */

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
setDefaultTimeout(60_000);

let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("agent-call-tool");
  if (!shared) {
    if (requireRealDatabase) throw new Error("PostgreSQL test database unavailable");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

type Handler = (
  input: Record<string, unknown>,
  extra: { signal: AbortSignal },
) => Promise<{ content: { text: string }[] }>;

/** A person with a chat their agent works in, and (optionally) a phone. */
async function setup(options: { phoneRules?: ("call" | "failed")[]; ringSeconds?: number } = {}) {
  const db = client.db;
  const userId = crypto.randomUUID();
  const subjectId = `user:${userId}`;
  await shared!.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, 'Ada', ${`ada-${userId}@example.test`}, true)`;
  await shared!.admin`
    insert into auth_identities (id, user_id, account_id, provider_id, created_at, updated_at)
    values (${crypto.randomUUID()}, ${userId}, ${userId}, 'credential', now(), now())`;
  await ensureCanonicalHumanIdentityForAuthUser(db, userId);
  await synchronizeCanonicalHumanLoginBindings(db, userId);
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "agent-call-tool",
    accountExternalId: `account:${crypto.randomUUID()}`,
    accountName: "Ada",
    workspaceExternalSource: "agent-call-tool",
    workspaceExternalId: `workspace:${crypto.randomUUID()}`,
    workspaceName: "Ada",
    subjectId,
    subjectLabel: "Ada",
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  if (options.phoneRules) {
    const projection = await getCanonicalHumanIdentityProjection(db, userId);
    const binding = await getCanonicalHumanExactLoginBindingForAuthUser(db, {
      authUserId: userId,
      providerId: "credential",
    });
    const authSessionId = crypto.randomUUID();
    await shared!.admin`
      insert into auth_sessions (
        id, user_id, token, expires_at, user_agent,
        identity_id, identity_revision, auth_revision, login_binding_id, login_binding_revision
      ) values (
        ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '7 days',
        'OpenGeni app (iOS)', ${projection.activeIdentity.id},
        ${projection.activeIdentity.identityRevision}, ${projection.activeIdentity.authRevision},
        ${binding.id}, ${binding.revision}
      )`;
    await registerNativePushDevice(db, {
      authSessionId,
      platform: "ios",
      appId: "ai.opengeni.app",
      environment: "development",
      token: "a".repeat(64),
      rules: options.phoneRules,
      voipToken: "b".repeat(64),
    });
  }
  const session = await createSession(db, {
    ...scope,
    initialMessage: "Watch the deploy",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId, label: "Ada" },
    createdByContext: { label: "Ada" },
  });
  await initializeSessionStartAtomically(db, {
    ...scope,
    sessionId: session.id,
    clientEventId: `initial:${session.id}`,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(db, scope.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`expected a claim, got ${claimed.action}`);
  const deps = { db, bus: new MemoryEventBus() };
  let handler: Handler | null = null;
  registerAgentCallTools({
    server: {
      registerTool: (_name: string, _config: unknown, registered: Handler) => {
        handler = registered;
      },
    } as never,
    deps: deps as never,
    grant: grant as never,
    sessionId: session.id,
    authorize: async () => undefined,
    attempt: () => ({
      callerTurnId: claimed.turn.id,
      callerExecutionGeneration: claimed.turn.executionGeneration,
      callerAttemptId: attemptId,
    }),
    json: (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] }),
    pollMs: 25,
    ...(options.ringSeconds ? { ringSeconds: options.ringSeconds } : {}),
  });
  const callUser = async (input: Record<string, unknown>, signal = new AbortController().signal) =>
    JSON.parse((await handler!(input, { signal })).content[0]!.text) as Record<string, any>;
  const ringingCall = async (): Promise<string> => {
    for (let index = 0; index < 200; index += 1) {
      const [row] = await shared!.admin<Array<{ id: string }>>`
        select id from agent_calls where session_id = ${session.id} and state = 'ringing'`;
      if (row) return row.id;
      await Bun.sleep(10);
    }
    throw new Error("the call never rang");
  };
  const eventTypes = async () =>
    (await listSessionEvents(db, scope.workspaceId, session.id))
      .map((event) => event.type)
      .filter((type) => type.startsWith("session.agentCall") || type.startsWith("session.notif"));
  return { db, deps, scope, subjectId, session, callUser, ringingCall, eventTypes };
}

describe("call_user", () => {
  test("rings nothing when the person allowed no calls, and says to notify instead", async () => {
    if (!shared) return;
    const { callUser, eventTypes } = await setup({ phoneRules: ["failed"] });
    const result = await callUser({ reason: "Production is down" });
    expect(result).toMatchObject({ placed: false, refusal: "no_phone" });
    expect(result.message).toContain("notify_user");
    expect(await eventTypes()).toEqual([]);
  });

  test("an answer on the phone returns answered while it rings", async () => {
    if (!shared) return;
    const { deps, scope, subjectId, callUser, ringingCall, eventTypes } = await setup({
      phoneRules: ["call"],
    });
    const pending = callUser({ reason: "Production is down" });
    const callId = await ringingCall();
    await finishAgentCall(deps as never, {
      ...scope,
      callId,
      outcome: "answered",
      calleeSubjectId: subjectId,
      answeredBy: "phone-1",
    });
    const result = await pending;
    expect(result).toMatchObject({ placed: true, callId, outcome: "answered", phones: 1 });
    expect(result.message).toContain("End this turn");
    expect(await eventTypes()).toEqual(["session.agentCall.ringing", "session.agentCall.settled"]);
  });

  test("a decline returns declined and keeps this chat from calling again", async () => {
    if (!shared) return;
    const { deps, scope, subjectId, callUser, ringingCall } = await setup({ phoneRules: ["call"] });
    const pending = callUser({ reason: "Need a yes on the refund" });
    const callId = await ringingCall();
    await finishAgentCall(deps as never, {
      ...scope,
      callId,
      outcome: "declined",
      calleeSubjectId: subjectId,
    });
    expect(await pending).toMatchObject({ outcome: "declined" });
    expect(await callUser({ reason: "Need a yes on the refund" })).toMatchObject({
      placed: false,
      refusal: "declined_recently",
    });
  });

  test("a call nobody answers is missed and leaves a missed-call notice", async () => {
    if (!shared) return;
    const { callUser, eventTypes } = await setup({ phoneRules: ["call"], ringSeconds: 1 });
    const result = await callUser({ reason: "Production is down" });
    expect(result).toMatchObject({ placed: true, outcome: "missed" });
    expect(await eventTypes()).toEqual([
      "session.agentCall.ringing",
      "session.agentCall.settled",
      "session.notification.posted",
    ]);
  });

  test("stopping the turn while it rings cancels the call", async () => {
    if (!shared) return;
    const { callUser, ringingCall } = await setup({ phoneRules: ["call"] });
    const controller = new AbortController();
    const pending = callUser({ reason: "Production is down" }, controller.signal);
    await ringingCall();
    controller.abort();
    expect(await pending).toMatchObject({ placed: true, outcome: "cancelled" });
  });
});
