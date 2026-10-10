import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  type AccessGrant,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

// Repeated agent mistakes observed on staging, replayed through a real MCP
// client so the SDK input validation runs exactly as it does for a model.
let shared: SharedTestDatabase;
let db: DbClient;
let client: Client;
let grant: AccessGrant;
let sessionId: string;
const BIG_OUTPUT = Array.from({ length: 4000 }, (_, line) => `report line ${line}`).join("\n");

async function call(args: Record<string, unknown>) {
  const result = (await client.callTool({ name: "session_events", arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  const text = result.content[0]?.text ?? "";
  return { isError: result.isError === true, text };
}
async function page(args: Record<string, unknown>) {
  const result = await call(args);
  if (result.isError) throw new Error(`session_events failed: ${result.text}`);
  return JSON.parse(result.text) as {
    view: string;
    events: Array<Record<string, unknown> & { sequence: number }>;
    hasMore: boolean;
    nextCursor: string | null;
    nextBefore: number | null;
    nextAfter: number | null;
  };
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-events-mcp-errors");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  db = createDb(shared.appUrl, { max: 2 });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db.db, {
    accountExternalSource: "test",
    accountExternalId: `session-events-errors-account-${suffix}`,
    accountName: "Session event error account",
    workspaceExternalSource: "test",
    workspaceExternalId: `session-events-errors-workspace-${suffix}`,
    workspaceName: "Session event error workspace",
    subjectId: `session-events-errors-subject-${suffix}`,
  });
  grant = access.workspaceGrants[0]!;
  const session = await createSession(db.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "session_events error fixture",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  sessionId = session.id;
  await appendSessionEvents(db.db, grant.workspaceId, sessionId, [
    { type: "user.message", payload: { text: "Track the goal" } },
    {
      type: "agent.toolCall.created",
      payload: { callId: "goal-1", name: "opengeni__goal_update", arguments: { note: "first" } },
    },
    { type: "agent.toolCall.output", payload: { id: "goal-1", output: "Goal updated: first" } },
    {
      type: "agent.toolCall.created",
      payload: { callId: "shell-1", name: "exec_command", arguments: { cmd: "ls" } },
    },
    { type: "agent.toolCall.output", payload: { id: "shell-1", output: "README.md" } },
    {
      type: "agent.toolCall.created",
      payload: { callId: "goal-2", name: "opengeni__goal_update", arguments: { note: "second" } },
    },
    { type: "agent.toolCall.output", payload: { id: "goal-2", output: "Goal updated: second" } },
    {
      type: "agent.toolCall.created",
      payload: { callId: "big-1", name: "big_report", arguments: { pages: 40 } },
    },
    { type: "agent.toolCall.output", payload: { id: "big-1", output: BIG_OUTPUT } },
    { type: "agent.message.completed", payload: { text: "Goal tracked" } },
    { type: "turn.completed", payload: { output: "Goal tracked" } },
  ]);
  const noop = async () => undefined;
  const server = buildOpenGeniMcpServer(
    {
      settings: testSettings({ databaseUrl: shared.appUrl }),
      db: db.db,
      bus: new MemoryEventBus(),
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
    } as unknown as ApiRouteDeps,
    grant,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "session-events-errors-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await db?.close();
  await shared?.release();
}, 60_000);

describe("session_events avoidable agent errors (real MCP client, PostgreSQL)", () => {
  test("toolName with includeOutput returns the newest named call with its result", async () => {
    const latest = await page({
      sessionId,
      view: "tools",
      toolName: "opengeni__goal_update",
      includeArguments: true,
      includeOutput: true,
      direction: "before",
      limit: 1,
    });
    expect(latest.events).toMatchObject([
      { kind: "call", callId: "goal-2", name: "opengeni__goal_update", text: '{"note":"second"}' },
      { kind: "result", callId: "goal-2", text: "Goal updated: second" },
    ]);
    expect(latest.hasMore).toBe(true);
    // The positional continuation keeps the named-output selection.
    const older = await page({ sessionId, cursor: latest.nextCursor! });
    expect(older.events.map((event) => [event.kind, event.callId, event.text])).toEqual([
      ["call", "goal-1", '{"note":"first"}'],
      ["result", "goal-1", "Goal updated: first"],
    ]);
    expect(older.hasMore).toBe(false);
    // The plain position reaches the same page without a cursor.
    const positional = await page({
      sessionId,
      view: "tools",
      toolName: "opengeni__goal_update",
      includeArguments: true,
      includeOutput: true,
      before: latest.nextBefore!,
      limit: 1,
    });
    expect(positional.events).toEqual(older.events);
  });

  test("named outputs clamp the page to three calls and default to the newest one", async () => {
    const all = await page({
      sessionId,
      view: "tools",
      toolName: "opengeni__goal_update",
      includeOutput: true,
      limit: 20,
    });
    expect(all).toMatchObject({ effectiveLimit: 3, hasMore: false, nextCursor: null });
    expect(all.events.map((event) => [event.kind, event.callId])).toEqual([
      ["call", "goal-1"],
      ["result", "goal-1"],
      ["call", "goal-2"],
      ["result", "goal-2"],
    ]);
    const defaulted = await page({
      sessionId,
      view: "tools",
      toolName: "opengeni__goal_update",
      includeOutput: true,
    });
    expect(defaulted.events.map((event) => event.callId)).toEqual(["goal-2", "goal-2"]);
  });

  test("an oversized named result keeps its lossless continuation", async () => {
    const first = await page({
      sessionId,
      view: "tools",
      toolName: "big_report",
      includeOutput: true,
    });
    expect(Buffer.byteLength(JSON.stringify(first, null, 2))).toBeLessThanOrEqual(16 * 1024);
    expect(first.events[0]).toMatchObject({ kind: "call", callId: "big-1" });
    const parts = [String(first.events[1]!.text)];
    let next = first.nextCursor;
    for (let count = 0; next; count += 1) {
      expect(count).toBeLessThan(20);
      const continued = await page({ sessionId, cursor: next });
      expect(Buffer.byteLength(JSON.stringify(continued, null, 2))).toBeLessThanOrEqual(16 * 1024);
      parts.push(...continued.events.map((event) => String(event.text)));
      next = continued.nextCursor;
    }
    expect(parts.join("")).toBe(BIG_OUTPUT);
  });

  test("a corrupted cursor names the exact cursor-free call", async () => {
    const first = await page({ sessionId, view: "tools", limit: 2 });
    const decoded = Buffer.from(first.nextCursor!, "base64url").toString();
    const misspelled = Buffer.from(decoded.replace('"sessionId"', '"sesionId"')).toString(
      "base64url",
    );
    const refused = await call({ sessionId, cursor: misspelled });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Invalid session_events cursor");
    const suggestion = JSON.parse(
      refused.text.slice(refused.text.indexOf("{"), refused.text.indexOf("}") + 1),
    );
    expect(suggestion).toEqual({
      sessionId,
      view: "tools",
      direction: "before",
      before: first.nextBefore,
      limit: 2,
    });
    // The suggested call succeeds and returns the same page the cursor would.
    expect((await page(suggestion)).events).toEqual(
      (await page({ sessionId, cursor: first.nextCursor! })).events,
    );
    const garbled = await call({ sessionId, cursor: "eyJ2IjoyLCJzZWxlY3Rpb24iOnsic2Vzc2l" });
    expect(garbled.isError).toBe(true);
    expect(garbled.text).toContain(
      JSON.stringify({ sessionId, direction: "before", before: "<nextBefore>" }),
    );
    expect(garbled.text).toContain(
      JSON.stringify({ sessionId, direction: "after", after: "<nextAfter>" }),
    );
  });

  test("a guessed event type lists the closest valid types", async () => {
    const started = await call({
      sessionId,
      view: "debug",
      includeTypes: ["agent.toolCall.started"],
    });
    expect(started.isError).toBe(true);
    expect(started.text).toContain("agent.toolCall.created, agent.toolCall.output");
    const goal = await call({ sessionId, view: "debug", includeTypes: ["goal.created"] });
    expect(goal.text).toContain("Valid goal.* types: goal.set, goal.updated");
    expect(goal.text).toContain("goal.completed");
  });

  test("tool selectors on view=results read view=tools; ambiguous flags get an example", async () => {
    const corrected = await page({
      sessionId,
      view: "results",
      callId: "goal-2",
      includeOutput: true,
    });
    expect(corrected.view).toBe("tools");
    expect(corrected).toMatchObject({ notice: expect.stringContaining("view=tools") });
    expect(corrected.events.find((event) => event.kind === "result")?.text).toBe(
      "Goal updated: second",
    );
    const flags = await call({ sessionId, view: "results", includeOutput: true });
    expect(flags.isError).toBe(true);
    expect(flags.text).toContain(`"view":"tools","toolName":"<exact tool name>"`);
    expect(flags.text).toContain(JSON.stringify({ sessionId, view: "results" }));
  });

  test("audit selectors on a content view name the corrected debug call", async () => {
    const refused = await call({ sessionId, view: "results", latest: "terminal" });
    expect(refused.isError).toBe(true);
    const debugCall = { sessionId, view: "debug", latest: "terminal" };
    expect(refused.text).toContain(JSON.stringify(debugCall));
    expect(refused.text).toContain(JSON.stringify({ sessionId, view: "results", limit: 1 }));
    const terminal = await call(debugCall);
    expect(terminal.isError).toBe(false);
    expect(JSON.parse(terminal.text).events[0]).toMatchObject({ type: "turn.completed" });
  });
});
