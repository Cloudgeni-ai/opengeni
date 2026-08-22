import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  addSessionSystemUpdate,
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
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
  SESSION_WAIT_EVENT_TYPES,
  SESSION_WAIT_EVENTS_PER_TARGET,
  SESSION_WAIT_MAX_SECONDS,
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

describe("session_wait MCP tool (real PostgreSQL, in-memory event bus)", () => {
  test("registers only for session-scoped grants holding sessions:read", () => {
    const sessionScoped = buildOpenGeniMcpServer(fakeDeps(new MemoryEventBus()), grant);
    expect(registeredToolNames(sessionScoped)).toContain("session_wait");

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

    // The bootstrap grant carries admin-equivalent permissions that imply
    // sessions:read, so the denial case uses an explicit unrelated permission.
    const noRead = buildOpenGeniMcpServer(fakeDeps(new MemoryEventBus()), {
      ...grant,
      permissions: ["sessions:create"],
    });
    expect(registeredToolNames(noRead)).not.toContain("session_wait");
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
});
