import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  TurnExecutionPolicyV1,
  type HostEventExportBatch,
  type HostUsageExportBatch,
  type SessionTurnSurface,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  acknowledgeHostExportBatch,
  addSessionSystemUpdate,
  appendSessionEvents,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimHostExportBatch,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  recordUsageEvent,
  registerHostExportConsumer,
  requestSessionCompaction,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/index";

// Real PostgreSQL: the turn surface is frozen where each request enters, the
// migration 0533 export triggers carry it next to origin with the model
// provider and tool family, and only fixed-list values ever leave the database.

let shared: SharedTestDatabase;
let app: ReturnType<typeof createDb>;
let exporter: ReturnType<typeof createDb>;

setDefaultTimeout(180_000);

const EVENT_CONSUMER = "surface-test-events";
const USAGE_CONSUMER = "surface-test-usage";

function policy(providerId: string) {
  return TurnExecutionPolicyV1.parse({
    schemaVersion: 1,
    productModelId: "codex/gpt-5.6-sol",
    requestedModelId: "codex/gpt-5.6-sol",
    modelSource: "explicit",
    reasoningEffort: "medium",
    reasoningSource: "explicit",
    providerId,
    upstreamModelId: "gpt-5.6-sol",
    wireApi: "responses",
    credentialSource: { kind: "connected_subscription", provider: "codex" },
    billing: { upstreamPayer: "connected_subscription", metering: "external" },
    definitionVersion: `sha256:${"c".repeat(64)}`,
  });
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("turn-surface-analytics");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  app = createDb(shared.appUrl);
  exporter = createDb(shared.adminUrl, { max: 2 });
  await registerHostExportConsumer(exporter.db, {
    kind: "session_event",
    consumerId: EVENT_CONSUMER,
  });
  await registerHostExportConsumer(exporter.db, {
    kind: "usage_event",
    consumerId: USAGE_CONSUMER,
  });
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([app?.close(), exporter?.close()]);
  await shared?.release();
});

async function startedSession(label: string, surface: SessionTurnSurface | null) {
  const subjectId = `subject:${label}:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "turn-surface-test",
    accountExternalId: `account:${label}:${crypto.randomUUID()}`,
    accountName: `Surface ${label}`,
    workspaceExternalSource: "turn-surface-test",
    workspaceExternalId: `workspace:${label}:${crypto.randomUUID()}`,
    workspaceName: `Surface ${label}`,
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(app.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: `initial ${label}`,
    resources: [],
    metadata: {},
    model: "codex/gpt-5.6-sol",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId },
  });
  const started = await initializeSessionStartAtomically(app.db, {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    turnExecutionPolicy: policy("codex-subscription"),
    surface,
    createdEventPayload: {},
    goal: null,
  });
  if (!started.turn) throw new Error("session did not create an initial turn");
  return { grant, workspaceId, session, turn: started.turn, subjectId };
}

type Started = Awaited<ReturnType<typeof startedSession>>;

function submit(
  ctx: Started,
  input: { text: string; surface?: SessionTurnSurface; providerId?: string },
) {
  return withWorkspaceSubjectSessionActivityRls(app.db, ctx.workspaceId, ctx.subjectId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.session.id,
        subjectId: ctx.subjectId,
        actor: { type: "human", subjectId: ctx.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: input.text,
        resources: [],
        reasoningEffortFallback: "medium",
        ...(input.providerId ? { turnExecutionPolicy: policy(input.providerId) } : {}),
        source: "user",
        ...(input.surface ? { surface: input.surface } : {}),
      }),
    ),
  );
}

async function claimNext(ctx: Started) {
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(app.db, ctx.workspaceId, {
    sessionId: ctx.session.id,
    workflowId: `session-${ctx.session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`expected a claim, got ${claimed.action}`);
  // The worker durably emits turn.started before model work; surface
  // inheritance, like model-policy inheritance, reads the latest started turn.
  await appendSessionEvents(app.db, ctx.workspaceId, ctx.session.id, [
    { type: "turn.started", payload: {}, turnId: claimed.turn.id },
  ]);
  return { claimed, attemptId };
}

async function settleIdle(
  ctx: Started,
  claim: Awaited<ReturnType<typeof claimNext>>,
): Promise<void> {
  const settled = await applySessionTurnSettlement(app.db, ctx.workspaceId, {
    sessionId: ctx.session.id,
    turnId: claim.claimed.turn.id,
    triggerEventId: claim.claimed.turn.triggerEventId,
    attemptId: claim.attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: { reason: "test" } }],
  });
  expect(settled.action).toBe("settled");
}

async function turnSurface(turnId: string): Promise<string | null> {
  const [row] = await shared.admin<Array<{ surface: string | null }>>`
    select surface from session_turns where id = ${turnId}`;
  if (!row) throw new Error(`turn ${turnId} not found`);
  return row.surface;
}

async function drainEvents(): Promise<HostEventExportBatch["events"]> {
  const events: HostEventExportBatch["events"] = [];
  for (;;) {
    const batch = await claimHostExportBatch(exporter.db, {
      kind: "session_event",
      consumerId: EVENT_CONSUMER,
      leaseToken: crypto.randomUUID(),
      leaseHolderId: `test-${crypto.randomUUID()}`,
      leaseSeconds: 30,
      limit: 256,
      maxBytes: 4_194_304,
    });
    if (!batch) return events;
    events.push(...batch.events);
    await acknowledgeHostExportBatch(exporter.db, {
      kind: "session_event",
      consumerId: EVENT_CONSUMER,
      leaseToken: batch.leaseToken,
    });
  }
}

async function drainUsage(): Promise<HostUsageExportBatch["events"]> {
  const events: HostUsageExportBatch["events"] = [];
  for (;;) {
    const batch = await claimHostExportBatch(exporter.db, {
      kind: "usage_event",
      consumerId: USAGE_CONSUMER,
      leaseToken: crypto.randomUUID(),
      leaseHolderId: `test-${crypto.randomUUID()}`,
      leaseSeconds: 30,
      limit: 256,
      maxBytes: 4_194_304,
    });
    if (!batch) return events;
    events.push(...batch.events);
    await acknowledgeHostExportBatch(exporter.db, {
      kind: "usage_event",
      consumerId: USAGE_CONSUMER,
      leaseToken: batch.leaseToken,
    });
  }
}

describe("turn surface analytics (real PostgreSQL)", () => {
  test("human turns freeze their entry surface and the export carries it with provider and tool family", async () => {
    const ctx = await startedSession("human", "web");
    expect(await turnSurface(ctx.turn.id)).toBe("web");

    const slack = await submit(ctx, {
      text: "from a Slack thread",
      surface: "slack",
      providerId: "self-hosted-llm",
    });
    expect(await turnSurface(slack.turnId)).toBe("slack");
    // A legacy low-level caller that names no surface records none.
    const legacy = await submit(ctx, { text: "no surface" });
    expect(await turnSurface(legacy.turnId)).toBeNull();

    const [integrationCall, forgedCall, firstPartyCall] = await appendSessionEvents(
      app.db,
      ctx.workspaceId,
      ctx.session.id,
      [
        {
          type: "agent.toolCall.created",
          payload: {
            id: "call-integration",
            name: "linear__list_issues",
            arguments: { query: "secret customer text" },
            toolFamily: "integration:mcp.linear.app",
          },
          turnId: ctx.turn.id,
        },
        {
          type: "agent.toolCall.created",
          payload: {
            id: "call-forged",
            name: "custom__tool",
            arguments: {},
            toolFamily: "integration:Customer Internal Host!",
          },
          turnId: ctx.turn.id,
        },
        {
          type: "agent.toolCall.created",
          payload: { id: "call-first-party", name: "exec_command", toolFamily: "exec_command" },
          turnId: ctx.turn.id,
        },
      ],
    );
    await recordUsageEvent(app.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.workspaceId,
      subjectId: ctx.subjectId,
      eventType: "model.tokens",
      quantity: 11,
      unit: "tokens",
      sourceResourceType: "model_response",
      sourceResourceId: `${slack.turnId}:one`,
      sessionId: ctx.session.id,
      turnId: slack.turnId,
      idempotencyKey: `usage:surface:${slack.turnId}`,
    });

    const events = (await drainEvents()).filter((item) => item.event.sessionId === ctx.session.id);
    const messages = events.filter((item) => item.event.type === "user.message");
    const byText = (text: string) =>
      messages.find((item) => (item.event.payload as { text?: string }).text === text);
    expect(byText("initial human")).toMatchObject({
      origin: "user",
      surface: "web",
      modelProvider: "codex-subscription",
    });
    // Operator-configured provider ids never leave as-is.
    expect(byText("from a Slack thread")).toMatchObject({
      origin: "user",
      surface: "slack",
      modelProvider: "registry",
    });
    expect(byText("no surface")).toMatchObject({ surface: null, modelProvider: null });

    const created = events.find((item) => item.event.type === "session.created");
    expect(created?.surface).toBeNull();
    expect(created?.toolFamily).toBeNull();

    const exported = (id: string | undefined) => events.find((item) => item.event.id === id);
    expect(exported(integrationCall?.id)).toMatchObject({
      surface: "web",
      modelProvider: "codex-subscription",
      toolFamily: "integration:mcp.linear.app",
    });
    // A value outside the fixed format exports as null instead of leaking.
    expect(exported(forgedCall?.id)?.toolFamily).toBeNull();
    expect(exported(firstPartyCall?.id)?.toolFamily).toBe("exec_command");
    expect(messages.every((item) => item.toolFamily === null)).toBe(true);

    const usage = (await drainUsage()).find((item) => item.turnId === slack.turnId);
    expect(usage).toMatchObject({ origin: "user", surface: "slack", modelProvider: "registry" });
  });

  test("internal turns take scheduled or agent from a new request and otherwise inherit the latest surface", async () => {
    const ctx = await startedSession("internal", "voice");
    const initial = await claimNext(ctx);
    expect(initial.claimed.turn.id).toBe(ctx.turn.id);
    await settleIdle(ctx, initial);

    // Maintenance continues the work that entered through voice.
    await requestSessionCompaction(app.db, ctx.workspaceId, ctx.session.id);
    const compaction = await claimNext(ctx);
    expect(compaction.claimed.turn.source).toBe("compaction");
    expect(await turnSurface(compaction.claimed.turn.id)).toBe("voice");
    await settleIdle(ctx, compaction);
    // The worker clears the request when it installs the compacted history.
    await shared.admin`update sessions set compact_requested = false where id = ${ctx.session.id}`;

    // Another agent's message is a new request from an agent.
    const message = await addSessionSystemUpdate(app.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.session.id,
      kind: "agent_message",
      classification: "info",
      sourceId: crypto.randomUUID(),
      dedupeKey: `agent-message-${crypto.randomUUID()}`,
      summary: "Peer session finished",
      payload: {
        type: "agent_message",
        text: "Peer session finished",
        operationId: crypto.randomUUID(),
      },
    });
    if (!message.added) throw new Error("agent message was not inserted");
    const agentTurn = await claimNext(ctx);
    expect(agentTurn.claimed.turn.source).toBe("system");
    expect(await turnSurface(agentTurn.claimed.turn.id)).toBe("agent");
  });

  test("the surface is immutable after admission and both columns are fixed-list checked", async () => {
    const ctx = await startedSession("immutable", "api_key");
    // postgres.js queries are lazy thenables; wrap them so `rejects` gets a Promise.
    await expect(
      (async () =>
        await shared.admin`update session_turns set surface = 'web' where id = ${ctx.turn.id}`)(),
    ).rejects.toMatchObject({ code: "55000" });
    expect(await turnSurface(ctx.turn.id)).toBe("api_key");
    const constraints = await shared.admin<Array<{ conname: string; convalidated: boolean }>>`
      select conname, convalidated from pg_constraint
      where conname in ('session_turns_surface_check', 'host_export_outbox_analytics_check')
      order by conname`;
    expect([...constraints]).toEqual([
      { conname: "host_export_outbox_analytics_check", convalidated: true },
      { conname: "session_turns_surface_check", convalidated: true },
    ]);
    await expect(
      (async () =>
        await shared.admin`update host_export_outbox set surface = 'email'
          where session_id = ${ctx.session.id}`)(),
    ).rejects.toMatchObject({ code: "23514" });
    const [provider] = await shared.admin<Array<{ known: string; registry: string; bad: null }>>`
      select opengeni_private.analytics_model_provider('azure') as known,
        opengeni_private.analytics_model_provider('self-hosted-llm') as registry,
        opengeni_private.analytics_model_provider('has spaces') as bad`;
    expect(provider).toEqual({ known: "azure", registry: "registry", bad: null });
  });
});
