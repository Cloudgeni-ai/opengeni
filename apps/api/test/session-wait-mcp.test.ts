import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  addSessionSystemUpdate,
  adoptConnectedMachineSessionBackgroundCommand,
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  settleConnectedMachineSessionBackgroundCommand,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { SESSION_EVENT_MCP_MAX_BYTES } from "../src/mcp/session-view";
import {
  SESSION_WAIT_COMPLETION_EVENT_TYPES,
  SESSION_WAIT_EVENT_TYPES,
  SESSION_WAIT_EVENTS_PER_TARGET,
  SESSION_WAIT_MAX_SECONDS,
  sessionWaitCompletionEventMatches,
} from "../src/mcp/session-wait";

type SessionWaitResult = {
  changed: Array<{
    sessionId: string;
    afterSequence: number;
    latestSequence: number;
    hasMore: boolean;
    events: Array<{
      sequence: number;
      type: string;
      status: string;
      text: string | null;
      result?: unknown;
      failure: { error: string | null; code: string | null } | null;
    }>;
  }>;
  ownPendingUpdates: number;
  ownPendingUpdateKinds: string[];
  waitedMs: number;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  bytes: number;
  maxBytes: number;
};
type CommandWaitResult = {
  command: { id: string; state: string; exitCode: number | null };
  terminal: boolean;
  waitedMs: number;
  timedOut: boolean;
  aborted: boolean;
  ownPendingUpdates: number;
  ownPendingUpdateKinds: string[];
  outputLocator?: { eventType: string; commandId: string };
};

let shared: SharedTestDatabase;
let client: DbClient;
let mcp: unknown;
let bus: MemoryEventBus;
let subscribeCalls = 0;
let accountId: string;
let workspaceId: string;
let selfSessionId: string;
let childSessionId: string;
let foreignWorkspaceId: string;
let foreignSessionId: string;
let grant: AccessGrant;

const noop = async () => undefined;

function fakeDeps(eventBus: MemoryEventBus): ApiRouteDeps {
  return {
    settings: testSettings({ databaseUrl: shared.appUrl }),
    db: client.db,
    bus: eventBus,
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps;
}

function registeredToolNames(server: unknown): string[] {
  return Object.keys(
    (server as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {},
  ).filter((name) => !name.startsWith("__opengeni_empty_"));
}

async function callSessionWait(
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  server: unknown = mcp,
): Promise<SessionWaitResult> {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools?.["session_wait"];
  if (!tool) throw new Error("MCP tool not registered: session_wait");
  const result = await tool.handler(args, extra);
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  if (!text) throw new Error("MCP tool returned no text: session_wait");
  return JSON.parse(text) as SessionWaitResult;
}

async function callCommandWait(
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  server: unknown = mcp,
): Promise<CommandWaitResult> {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools?.["command_wait"];
  if (!tool) throw new Error("MCP tool not registered: command_wait");
  const result = await tool.handler(args, extra);
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  if (!text) throw new Error("MCP tool returned no text: command_wait");
  return JSON.parse(text) as CommandWaitResult;
}

async function newSession(targetWorkspaceId: string, message: string): Promise<string> {
  const session = await createSession(client.db, {
    accountId,
    workspaceId: targetWorkspaceId,
    initialMessage: message,
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return session.id;
}

async function lastSequence(sessionId: string): Promise<number> {
  const [row] = await shared.admin<Array<{ last: number | null }>>`
    select max(sequence)::int as last from session_events where session_id = ${sessionId}
  `;
  return row?.last ?? 0;
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-wait-mcp");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `session-wait-mcp-account-${suffix}`,
    accountName: "Session wait MCP account",
    workspaceExternalSource: "test",
    workspaceExternalId: `session-wait-mcp-workspace-${suffix}`,
    workspaceName: "Session wait MCP workspace",
    subjectId: `session-wait-mcp-subject-${suffix}`,
  });
  const workspaceGrant = access.workspaceGrants[0]!;
  accountId = workspaceGrant.accountId;
  workspaceId = workspaceGrant.workspaceId;
  const foreign = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `session-wait-mcp-foreign-account-${suffix}`,
    accountName: "Session wait MCP foreign account",
    workspaceExternalSource: "test",
    workspaceExternalId: `session-wait-mcp-foreign-workspace-${suffix}`,
    workspaceName: "Session wait MCP foreign workspace",
    subjectId: `session-wait-mcp-foreign-subject-${suffix}`,
  });
  foreignWorkspaceId = foreign.workspaceGrants[0]!.workspaceId;
  const foreignSession = await createSession(client.db, {
    accountId: foreign.workspaceGrants[0]!.accountId,
    workspaceId: foreignWorkspaceId,
    initialMessage: "foreign fixture",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  foreignSessionId = foreignSession.id;

  selfSessionId = await newSession(workspaceId, "manager fixture");
  childSessionId = await newSession(workspaceId, "child fixture");

  bus = new MemoryEventBus();
  const originalSubscribe = bus.subscribe.bind(bus);
  bus.subscribe = async (...args: Parameters<MemoryEventBus["subscribe"]>) => {
    subscribeCalls += 1;
    return await originalSubscribe(...args);
  };
  // A session-scoped grant: the worker-signed sessionId claim is the self
  // session whose pending machine input the wait also watches.
  grant = {
    ...workspaceGrant,
    metadata: { ...(workspaceGrant.metadata ?? {}), sessionId: selfSessionId },
  };
  mcp = buildOpenGeniMcpServer(fakeDeps(bus), grant);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

describe("session_wait and command_wait MCP tools (real PostgreSQL, in-memory event bus)", () => {
  test("registers only for session-scoped grants holding sessions:read", () => {
    const sessionScoped = buildOpenGeniMcpServer(fakeDeps(new MemoryEventBus()), grant);
    expect(registeredToolNames(sessionScoped)).toContain("session_wait");
    expect(registeredToolNames(sessionScoped)).toContain("command_wait");

    const { sessionId: _omitted, ...metadataWithoutSession } = (grant.metadata ?? {}) as Record<
      string,
      unknown
    >;
    const noSession = buildOpenGeniMcpServer(fakeDeps(new MemoryEventBus()), {
      ...grant,
      metadata: metadataWithoutSession,
    });
    expect(registeredToolNames(noSession)).toContain("session_events");
    expect(registeredToolNames(noSession)).not.toContain("session_wait");
    expect(registeredToolNames(noSession)).not.toContain("command_wait");

    // The bootstrap grant carries admin-equivalent permissions that imply
    // sessions:read, so the denial case uses an explicit unrelated permission.
    const noRead = buildOpenGeniMcpServer(fakeDeps(new MemoryEventBus()), {
      ...grant,
      permissions: ["sessions:create"],
    });
    expect(registeredToolNames(noRead)).not.toContain("session_wait");
    expect(registeredToolNames(noRead)).not.toContain("command_wait");
    expect(registeredToolNames(noRead)).not.toContain("session_events");
  });

  test("returns immediately when the durable pre-check already finds a matching event", async () => {
    await appendSessionEvents(client.db, workspaceId, childSessionId, [
      { type: "agent.message.delta", payload: { text: "ignored raw delta" } },
      { type: "turn.completed", payload: { result: "child finished" }, turnGeneration: 1 },
    ]);
    const before = subscribeCalls;
    const result = await callSessionWait({
      targets: [{ sessionId: childSessionId, afterSequence: 0 }],
      maxWaitSeconds: SESSION_WAIT_MAX_SECONDS,
    });
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.waitedMs).toBeLessThan(2_000);
    expect(result.changed).toHaveLength(1);
    const [changed] = result.changed;
    expect(changed!.sessionId).toBe(childSessionId);
    expect(changed!.afterSequence).toBe(0);
    expect(changed!.hasMore).toBe(false);
    expect(changed!.events.map((event) => event.type)).toEqual(["turn.completed"]);
    expect(changed!.events[0]).toMatchObject({ status: "completed", result: "child finished" });
    expect(changed!.latestSequence).toBe(changed!.events[0]!.sequence);
    expect(result.ownPendingUpdates).toBe(0);
    // Subscriptions are opened before the durable read and always released.
    expect(subscribeCalls - before).toBe(2);
    expect(result.bytes).toBeLessThanOrEqual(result.maxBytes);
    expect(result.maxBytes).toBe(SESSION_EVENT_MCP_MAX_BYTES);
  });

  test("wakes from the event bus and returns the exact durable events after the cursor", async () => {
    const cursor = await lastSequence(childSessionId);
    const startedAt = Date.now();
    const pending = callSessionWait({
      targets: [{ sessionId: childSessionId, afterSequence: cursor }],
      maxWaitSeconds: SESSION_WAIT_MAX_SECONDS,
    });
    await Bun.sleep(400);
    const appended = await appendSessionEvents(client.db, workspaceId, childSessionId, [
      { type: "agent.message.completed", payload: { text: "progress report" } },
    ]);
    await bus.publish(workspaceId, childSessionId, appended);
    const result = await pending;
    expect(result.timedOut).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(300);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]!.events).toEqual([
      expect.objectContaining({
        sequence: appended[0]!.sequence,
        type: "agent.message.completed",
        text: "progress report",
      }),
    ]);
    expect(result.changed[0]!.latestSequence).toBe(appended[0]!.sequence);

    // The returned cursor is exact: nothing newer means a clean timeout.
    const again = await callSessionWait({
      targets: [{ sessionId: childSessionId, afterSequence: result.changed[0]!.latestSequence }],
      maxWaitSeconds: 1,
    });
    expect(again.changed).toEqual([]);
    expect(again.timedOut).toBe(true);
  }, 30_000);

  test("completion mode ignores progress and continuation settlements until a result-bearing turn", async () => {
    const target = await newSession(workspaceId, "completion-aware child fixture");
    const cursor = await lastSequence(target);
    const progressEvents = await appendSessionEvents(client.db, workspaceId, target, [
      { type: "goal.completed", payload: { summary: "goal state settled before output" } },
      {
        type: "agent.message.completed",
        payload: { text: "commentary is not the final child result", phase: "commentary" },
      },
      { type: "turn.completed", payload: { output: "", segmentLimit: "max_turns" } },
      {
        type: "turn.completed",
        payload: { maintenance: "context_compaction", result: "compacted" },
      },
    ]);
    await bus.publish(workspaceId, target, progressEvents);

    const early = await callSessionWait({
      targets: [{ sessionId: target, afterSequence: cursor }],
      waitFor: "completion",
      includeOwnPendingUpdates: false,
      maxWaitSeconds: 1,
    });
    expect(early.timedOut).toBe(true);
    expect(early.changed).toEqual([]);
    expect(progressEvents.some(sessionWaitCompletionEventMatches)).toBe(false);

    const resultEvents = await appendSessionEvents(client.db, workspaceId, target, [
      { type: "agent.message.completed", payload: { text: "detailed child result" } },
      { type: "turn.completed", payload: { output: "detailed child result" } },
    ]);
    await bus.publish(workspaceId, target, resultEvents);
    const completed = await callSessionWait({
      targets: [{ sessionId: target, afterSequence: cursor }],
      waitFor: "completion",
      includeOwnPendingUpdates: false,
      maxWaitSeconds: SESSION_WAIT_MAX_SECONDS,
    });
    expect(completed.timedOut).toBe(false);
    expect(completed.changed[0]!.events).toEqual([
      expect.objectContaining({
        sequence: resultEvents[1]!.sequence,
        type: "turn.completed",
        text: "detailed child result",
      }),
    ]);
    expect(
      completed.changed[0]!.events.every((event) =>
        SESSION_WAIT_COMPLETION_EVENT_TYPES.includes(event.type as never),
      ),
    ).toBeTrue();
    expect(sessionWaitCompletionEventMatches(resultEvents[1]!)).toBe(true);
  }, 30_000);

  test("ignores non-wait event types and times out truthfully at the deadline", async () => {
    const cursor = await lastSequence(childSessionId);
    const appended = await appendSessionEvents(client.db, workspaceId, childSessionId, [
      { type: "agent.message.delta", payload: { text: "still streaming" } },
      { type: "agent.toolCall.created", payload: { name: "exec_command" } },
    ]);
    await bus.publish(workspaceId, childSessionId, appended);
    const result = await callSessionWait({
      targets: [{ sessionId: childSessionId, afterSequence: cursor }],
      maxWaitSeconds: 1,
    });
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.changed).toEqual([]);
    expect(result.waitedMs).toBeGreaterThanOrEqual(900);
    expect(result.waitedMs).toBeLessThan(5_000);
  }, 30_000);

  test("returns promptly without events when the MCP request is aborted", async () => {
    const cursor = await lastSequence(childSessionId);
    const controller = new AbortController();
    const pending = callSessionWait(
      {
        targets: [{ sessionId: childSessionId, afterSequence: cursor }],
        maxWaitSeconds: SESSION_WAIT_MAX_SECONDS,
      },
      { signal: controller.signal },
    );
    await Bun.sleep(150);
    controller.abort();
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.changed).toEqual([]);
    expect(result.waitedMs).toBeLessThan(5_000);
  }, 30_000);

  test("reports the caller's own pending machine input", async () => {
    const cursor = await lastSequence(childSessionId);

    const update = await addSessionSystemUpdate(client.db, {
      accountId,
      workspaceId,
      sessionId: selfSessionId,
      kind: "child_terminal_result",
      classification: "success",
      sourceId: crypto.randomUUID(),
      dedupeKey: `session-wait:${crypto.randomUUID()}`,
      summary: "Child completed",
      payload: {
        type: "child_terminal_result",
        childSessionId,
        status: "idle",
      },
    });
    expect(update.added).toBe(true);
    const result = await callSessionWait({
      targets: [{ sessionId: childSessionId, afterSequence: cursor }],
      maxWaitSeconds: SESSION_WAIT_MAX_SECONDS,
    });
    expect(result.timedOut).toBe(false);
    expect(result.changed).toEqual([]);
    expect(result.ownPendingUpdates).toBe(1);
    expect(result.ownPendingUpdateKinds).toEqual(["child_terminal_result"]);

    const ignored = await callSessionWait({
      targets: [{ sessionId: childSessionId, afterSequence: cursor }],
      includeOwnPendingUpdates: false,
      maxWaitSeconds: 1,
    });
    expect(ignored.timedOut).toBe(true);
    expect(ignored.ownPendingUpdates).toBe(0);
  }, 30_000);

  test("reports a deferred child notice without ending the wait on it", async () => {
    const cursor = await lastSequence(childSessionId);
    const ownSession = await newSession(workspaceId, "deferred-only owner");
    const deferred = await addSessionSystemUpdate(client.db, {
      accountId,
      workspaceId,
      sessionId: ownSession,
      kind: "child_progress",
      classification: "info",
      sourceId: childSessionId,
      dedupeKey: `session-wait:${crypto.randomUUID()}`,
      summary: "Worker progress",
      payload: {
        type: "child_progress",
        childSessionId,
        goalId: crypto.randomUUID(),
        objectiveRevision: 1,
        operationId: crypto.randomUUID(),
        progressNote: "halfway",
      },
    });
    expect(deferred.added).toBe(true);
    if (deferred.reason === "added") expect(deferred.shouldWake).toBe(false);
    const ownServer = buildOpenGeniMcpServer(fakeDeps(bus), {
      ...grant,
      metadata: { ...grant.metadata, sessionId: ownSession },
    });
    const result = (await callSessionWait(
      {
        targets: [{ sessionId: childSessionId, afterSequence: cursor }],
        maxWaitSeconds: 1,
      },
      {},
      ownServer,
    )) as SessionWaitResult & {
      ownPendingImmediateUpdates: number;
      ownPendingDeferredUpdateKinds: string[];
    };
    // A deferred notice is reported but does not end the wait by itself.
    expect(result.timedOut).toBe(true);
    expect(result.changed).toEqual([]);
    expect(result.ownPendingUpdates).toBe(1);
    expect(result.ownPendingUpdateKinds).toEqual(["child_progress"]);
    expect(result.ownPendingImmediateUpdates).toBe(0);
    expect(result.ownPendingDeferredUpdateKinds).toEqual(["child_progress"]);

    const immediate = await addSessionSystemUpdate(client.db, {
      accountId,
      workspaceId,
      sessionId: ownSession,
      kind: "child_requires_action",
      classification: "action_required",
      sourceId: childSessionId,
      dedupeKey: `session-wait:${crypto.randomUUID()}`,
      summary: "Worker needs input",
      payload: {
        type: "child_requires_action",
        childSessionId,
        childTurnId: crypto.randomUUID(),
        childTurnGeneration: 1,
        requests: [],
        truncated: false,
      },
    });
    expect(immediate.added).toBe(true);
    const woke = (await callSessionWait(
      {
        targets: [{ sessionId: childSessionId, afterSequence: cursor }],
        maxWaitSeconds: SESSION_WAIT_MAX_SECONDS,
      },
      {},
      ownServer,
    )) as SessionWaitResult & { ownPendingImmediateUpdates: number };
    expect(woke.timedOut).toBe(false);
    expect(woke.ownPendingUpdates).toBe(2);
    expect(woke.ownPendingImmediateUpdates).toBe(1);
    expect(woke.ownPendingUpdateKinds).toEqual(["child_progress", "child_requires_action"]);
  }, 30_000);

  test("refuses an unauthorized target before subscribing to any live fanout", async () => {
    const before = subscribeCalls;
    await expect(
      callSessionWait({
        targets: [
          { sessionId: childSessionId, afterSequence: 0 },
          { sessionId: foreignSessionId, afterSequence: 0 },
        ],
        maxWaitSeconds: 1,
      }),
    ).rejects.toThrow(/not found/i);
    expect(subscribeCalls).toBe(before);
    expect(foreignWorkspaceId).not.toBe(workspaceId);

    await expect(
      callSessionWait({
        targets: [
          { sessionId: childSessionId, afterSequence: 0 },
          { sessionId: childSessionId, afterSequence: 3 },
        ],
      }),
    ).rejects.toThrow(/distinct/);
  });

  test("byte-bounds the result and keeps latestSequence an exact delivered cursor", async () => {
    const oversizedTarget = await newSession(workspaceId, "noisy child fixture");
    const big = "x".repeat(12_000);
    await appendSessionEvents(
      client.db,
      workspaceId,
      oversizedTarget,
      Array.from({ length: SESSION_WAIT_EVENTS_PER_TARGET + 10 }, (_, index) => ({
        type: "agent.message.completed" as const,
        payload: { text: `${index}:${big}` },
      })),
    );
    const result = await callSessionWait({
      targets: [{ sessionId: oversizedTarget, afterSequence: 0 }],
      maxWaitSeconds: SESSION_WAIT_MAX_SECONDS,
    });
    expect(result.bytes).toBeLessThanOrEqual(SESSION_EVENT_MCP_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(result, null, 2), "utf8")).toBe(result.bytes);
    expect(result.truncated).toBe(true);
    const [changed] = result.changed;
    expect(changed!.hasMore).toBe(true);
    expect(changed!.events.length).toBeGreaterThan(0);
    expect(changed!.events.length).toBeLessThanOrEqual(SESSION_WAIT_EVENTS_PER_TARGET);
    expect(changed!.latestSequence).toBe(changed!.events[changed!.events.length - 1]!.sequence);
    expect(
      changed!.events.every((event) => SESSION_WAIT_EVENT_TYPES.includes(event.type as never)),
    ).toBeTrue();
  }, 30_000);

  test("degrades to the durable pre-check and deadline when live fanout is unavailable", async () => {
    const brokenBus = new MemoryEventBus();
    brokenBus.subscribe = async () => {
      throw new Error("NATS unavailable");
    };
    const degraded = buildOpenGeniMcpServer(fakeDeps(brokenBus), grant);
    const target = await newSession(workspaceId, "degraded child fixture");
    await appendSessionEvents(client.db, workspaceId, target, [
      { type: "turn.completed", payload: { result: "already there" } },
    ]);
    const hit = await callSessionWait(
      {
        targets: [{ sessionId: target, afterSequence: 0 }],
        includeOwnPendingUpdates: false,
        maxWaitSeconds: 5,
      },
      {},
      degraded,
    );
    expect(hit.liveFanout).toBe(false);
    expect(hit.timedOut).toBe(false);
    expect(hit.changed[0]!.events.map((event) => event.type)).toEqual(["turn.completed"]);

    const cursor = await lastSequence(target);
    const pending = callSessionWait(
      {
        targets: [{ sessionId: target, afterSequence: cursor }],
        includeOwnPendingUpdates: false,
        maxWaitSeconds: 2,
      },
      {},
      degraded,
    );
    await Bun.sleep(300);
    // Committed while waiting, with no live fanout: the deadline re-check finds it.
    await appendSessionEvents(client.db, workspaceId, target, [
      { type: "turn.failed", payload: { error: "late failure" } },
    ]);
    const late = await pending;
    expect(late.liveFanout).toBe(false);
    expect(late.timedOut).toBe(false);
    expect(late.waitedMs).toBeGreaterThanOrEqual(1_500);
    expect(late.changed[0]!.events.map((event) => event.type)).toEqual(["turn.failed"]);
  }, 30_000);

  test("an exact live agent attempt can wait on a child and on its own pending input", async () => {
    const claimSessionId = await newSession(workspaceId, "claimed manager fixture");
    const childOfClaim = await newSession(workspaceId, "claimed child fixture");
    const humanSubjectId = grant.subjectId;
    // The attempt's frozen initiating human is a different person than the
    // workspace member who will own the private session below.
    const otherHuman = `session-wait-other-human-${crypto.randomUUID()}`;
    const executionGeneration = 1;
    const [turn] = await shared.admin<Array<{ id: string }>>`
      insert into session_turns (
        account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, position, prompt, model, reasoning_effort, sandbox_backend,
        execution_generation, initiator_kind, initiator_subject_id,
        initiating_human_subject_id, initiator_context
      ) values (
        ${accountId}, ${workspaceId}, ${claimSessionId}, gen_random_uuid(),
        ${`session-wait-${crypto.randomUUID()}`}, 'running', 0, 'wait for the child',
        'test-model', 'medium', 'none', ${executionGeneration}, 'subject', ${otherHuman},
        ${otherHuman}, '{"accepted":true}'::jsonb
      ) returning id
    `;
    const [authority] = await shared.admin<
      Array<{
        authorityEpoch: number;
        visibility: string;
        ownerOrganizationMembershipId: string | null;
      }>
    >`
      select authority_epoch as "authorityEpoch", visibility,
        owner_organization_membership_id as "ownerOrganizationMembershipId"
      from sessions where id = ${claimSessionId}
    `;
    const attemptId = crypto.randomUUID();
    await shared.admin.begin(async (tx) => {
      await tx.unsafe("set local opengeni.session_inference_claim = '1'");
      await tx`
        update sessions set active_turn_id = ${turn!.id}, status = 'running'
        where id = ${claimSessionId}
      `;
      await tx`
        update session_turns set active_attempt_id = ${attemptId}, status = 'running'
        where id = ${turn!.id}
      `;
      await tx`
        insert into session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id, execution_generation,
          state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
          verified_control_revision, authority_epoch, authority_visibility,
          authority_owner_organization_membership_id, mcp_approval_policies,
          connector_action_policies
        ) values (
          ${attemptId}, ${accountId}, ${workspaceId}, ${claimSessionId}, ${turn!.id},
          ${executionGeneration}, 'running', 'session-wait', ${`run-${attemptId}`},
          ${`activity-${attemptId}`}, 0, ${authority!.authorityEpoch},
          ${authority!.visibility}, ${authority!.ownerOrganizationMembershipId},
          '{}'::jsonb, '[]'::jsonb
        )
      `;
    });
    const attemptGrant: AccessGrant = {
      accountId,
      workspaceId,
      subjectId: "worker:first-party-mcp",
      principalKind: "agent_attempt",
      permissions: ["sessions:read"],
      metadata: {
        sessionId: claimSessionId,
        turnId: turn!.id,
        attemptId,
        executionGeneration,
        firstPartyMcpTools: ["session_wait", "command_wait"],
      },
    };
    const attemptBus = new MemoryEventBus();
    const attemptServer = buildOpenGeniMcpServer(fakeDeps(attemptBus), attemptGrant);
    expect(registeredToolNames(attemptServer)).toEqual(["session_wait", "command_wait"]);

    const pending = callSessionWait(
      { targets: [{ sessionId: childOfClaim, afterSequence: 0 }], maxWaitSeconds: 20 },
      {},
      attemptServer,
    );
    await Bun.sleep(300);
    const appended = await appendSessionEvents(client.db, workspaceId, childOfClaim, [
      { type: "goal.completed", payload: { summary: "child goal done" } },
    ]);
    await attemptBus.publish(workspaceId, childOfClaim, appended);
    const result = await pending;
    expect(result.timedOut).toBe(false);
    expect(result.changed[0]!.events.map((event) => event.type)).toEqual(["goal.completed"]);
    expect(result.ownPendingUpdates).toBe(0);

    const commandId = crypto.randomUUID();
    const enrollmentId = crypto.randomUUID();
    const connectionInstanceId = "session-wait-command-instance";
    const opId = "session-wait-command-op";
    await adoptConnectedMachineSessionBackgroundCommand(client.db, {
      accountId,
      workspaceId,
      sessionId: claimSessionId,
      turnId: turn!.id,
      executionGeneration,
      attemptId,
      commandId,
      controlWorkspaceId: workspaceId,
      enrollmentId,
      connectionInstanceId,
      opId,
      command: "printf done",
    });
    const commandPending = callCommandWait({ commandId, maxWaitSeconds: 20 }, {}, attemptServer);
    await Bun.sleep(300);
    const commandSettlement = await settleConnectedMachineSessionBackgroundCommand(client.db, {
      accountId,
      workspaceId,
      sessionId: claimSessionId,
      commandId,
      controlWorkspaceId: workspaceId,
      enrollmentId,
      connectionInstanceId,
      opId,
      outcome: "exited",
      exitCode: 0,
      reason: "op_completed",
    });
    expect(commandSettlement).not.toBeNull();
    await attemptBus.publish(workspaceId, claimSessionId, commandSettlement!.events);
    const commandResult = await commandPending;
    expect(commandResult).toMatchObject({
      terminal: true,
      timedOut: false,
      ownPendingUpdates: 1,
      ownPendingUpdateKinds: ["background_command_result"],
      command: { id: commandId, state: "exited", exitCode: 0 },
      outputLocator: { eventType: "sandbox.command.output.delta", commandId },
    });
    expect(commandResult.waitedMs).toBeGreaterThanOrEqual(200);

    const immediateCommandResult = await callCommandWait(
      { commandId, maxWaitSeconds: 20 },
      {},
      attemptServer,
    );
    expect(immediateCommandResult).toMatchObject({
      terminal: true,
      timedOut: false,
      ownPendingUpdates: 1,
      ownPendingUpdateKinds: ["background_command_result"],
    });
    expect(immediateCommandResult.waitedMs).toBe(0);

    let authorizationCalls = 0;
    const revokingDeps = fakeDeps(attemptBus);
    revokingDeps.sessionAuthorization = {
      authorizeSession: async () => {
        authorizationCalls += 1;
        return authorizationCalls === 1
          ? { allowed: true as const, relatedSessionAccess: "target" as const }
          : { allowed: false as const, reason: "revoked" as const };
      },
      resolveListScope: async () => ({ kind: "all" as const }),
    };
    const revokingServer = buildOpenGeniMcpServer(revokingDeps, attemptGrant);
    const revokedCommandId = crypto.randomUUID();
    const revokedOpId = "session-wait-revoked-command-op";
    await adoptConnectedMachineSessionBackgroundCommand(client.db, {
      accountId,
      workspaceId,
      sessionId: claimSessionId,
      turnId: turn!.id,
      executionGeneration,
      attemptId,
      commandId: revokedCommandId,
      controlWorkspaceId: workspaceId,
      enrollmentId,
      connectionInstanceId,
      opId: revokedOpId,
      command: "printf revoked",
    });
    const revokedExpectation = expect(
      callCommandWait({ commandId: revokedCommandId, maxWaitSeconds: 20 }, {}, revokingServer),
    ).rejects.toThrow();
    await Bun.sleep(300);
    const revokedSettlement = await settleConnectedMachineSessionBackgroundCommand(client.db, {
      accountId,
      workspaceId,
      sessionId: claimSessionId,
      commandId: revokedCommandId,
      controlWorkspaceId: workspaceId,
      enrollmentId,
      connectionInstanceId,
      opId: revokedOpId,
      outcome: "exited",
      exitCode: 0,
      reason: "op_completed",
    });
    expect(revokedSettlement).not.toBeNull();
    await attemptBus.publish(workspaceId, claimSessionId, revokedSettlement!.events);
    await revokedExpectation;
    expect(authorizationCalls).toBe(2);

    const update = await addSessionSystemUpdate(client.db, {
      accountId,
      workspaceId,
      sessionId: claimSessionId,
      kind: "child_terminal_result",
      classification: "success",
      sourceId: crypto.randomUUID(),
      dedupeKey: `session-wait-claim:${crypto.randomUUID()}`,
      summary: "Child completed",
      payload: { type: "child_terminal_result", childSessionId: childOfClaim, status: "idle" },
    });
    expect(update.added).toBe(true);
    const own = await callSessionWait(
      {
        targets: [{ sessionId: childOfClaim, afterSequence: result.changed[0]!.latestSequence }],
        maxWaitSeconds: 5,
      },
      {},
      attemptServer,
    );
    expect(own.ownPendingUpdates).toBe(3);
    expect(own.changed).toEqual([]);

    // A Slack-private session outside this attempt's root is refused: the
    // durable Slack ownership fence runs inside requireSessionAuthorization
    // even without an embedding-host port.
    const privateSession = await newSession(workspaceId, "slack private fixture");
    const [connection] = await shared.admin<Array<{ id: string }>>`
      insert into connections (
        account_id, workspace_id, provider_domain, kind, status, credential_encrypted
      ) values (${accountId}, ${workspaceId}, 'slack.com', 'app_install', 'active', 'sealed')
      returning id
    `;
    await shared.admin`
      insert into slack_interactions (
        account_id, workspace_id, connection_id, slack_team_id, slack_channel_id,
        slack_thread_ts, route_key, triggering_provider_event_id, owning_subject_id,
        visibility, session_reservation_id, session_id
      ) values (
        ${accountId}, ${workspaceId}, ${connection!.id}, 'T1', 'D1', '1.1',
        ${`route-${crypto.randomUUID()}`}, ${`evt-${crypto.randomUUID()}`},
        ${humanSubjectId}, 'private', ${privateSession}, ${privateSession}
      )
    `;
    const before = subscribeCalls;
    await expect(
      callSessionWait(
        { targets: [{ sessionId: privateSession, afterSequence: 0 }], maxWaitSeconds: 1 },
        {},
        attemptServer,
      ),
    ).rejects.toThrow();
    expect(subscribeCalls).toBe(before);
  }, 60_000);
});
