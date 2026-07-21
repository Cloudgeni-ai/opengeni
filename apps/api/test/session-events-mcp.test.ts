import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
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
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

let shared: SharedTestDatabase;
let client: DbClient;
let mcp: unknown;
let workspaceId: string;
let sessionId: string;

async function callMcpTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const tool = (
    mcp as {
      _registeredTools?: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) throw new Error(`MCP tool not registered: ${name}`);
  const result = await tool.handler(args, {});
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  if (!text) throw new Error(`MCP tool returned no text: ${name}`);
  return JSON.parse(text) as T;
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-events-mcp");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `session-events-mcp-account-${suffix}`,
    accountName: "Session event MCP account",
    workspaceExternalSource: "test",
    workspaceExternalId: `session-events-mcp-workspace-${suffix}`,
    workspaceName: "Session event MCP workspace",
    subjectId: `session-events-mcp-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  workspaceId = grant.workspaceId;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "bounded MCP event fixture",
    resources: [],
    metadata: {},
    model: "test-model",
    sandboxBackend: "none",
  });
  sessionId = session.id;

  const noop = async () => undefined;
  mcp = buildOpenGeniMcpServer(
    {
      settings: testSettings({ databaseUrl: shared.appUrl }),
      db: client.db,
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

  await appendSessionEvents(client.db, workspaceId, sessionId, [
    ...Array.from({ length: 40 }, () => ({
      type: "agent.message.delta" as const,
      payload: { text: "raw-token-fragment" },
    })),
    {
      type: "session.context.compacted" as const,
      payload: { checkpoint: "current" },
      turnGeneration: 1,
    },
    {
      type: "turn.completed" as const,
      payload: { result: "stale" },
      turnGeneration: 1,
    },
    {
      type: "turn.completed" as const,
      payload: { result: "authoritative" },
      turnGeneration: 2,
    },
    {
      type: "machine.op.failed" as const,
      payload: { code: "NEWER_UNRELATED_FAILURE" },
      turnGeneration: 2,
    },
  ]);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

describe("session_events MCP model boundary (real PostgreSQL)", () => {
  test("defaults to a semantic tail and keeps explicit forensic replay exact", async () => {
    const monitoring = await callMcpTool<{
      events: Array<{ sequence: number; type: string }>;
      direction: string;
      nextAfter: number | null;
      nextBefore: number | null;
    }>("session_events", { sessionId });
    expect(monitoring.events.map((event) => [event.sequence, event.type])).toEqual([
      [41, "session.context.compacted"],
      [42, "turn.completed"],
      [43, "turn.completed"],
      [44, "machine.op.failed"],
    ]);
    expect(monitoring.direction).toBe("before");
    expect(monitoring.nextAfter).toBeNull();
    expect(monitoring.nextBefore).toBe(41);

    const forensic = await callMcpTool<{
      events: Array<{ sequence: number; type: string; payload: unknown }>;
      direction: string;
      nextAfter: number;
    }>("session_events", {
      sessionId,
      after: 0,
      limit: 40,
      mode: "forensic",
      payloadMode: "full",
    });
    expect(forensic.events).toHaveLength(40);
    expect(forensic.events.every((event) => event.type === "agent.message.delta")).toBeTrue();
    expect(forensic.direction).toBe("after");
    expect(forensic.nextAfter).toBe(40);
  });

  test("returns the authoritative latest terminal generation directly", async () => {
    const latest = await callMcpTool<{
      events: Array<{
        sequence: number;
        type: string;
        turnGeneration: number | null;
        payload: unknown;
      }>;
    }>("session_events", { sessionId, latest: "terminal" });
    expect(latest.events).toEqual([
      expect.objectContaining({
        sequence: 43,
        type: "turn.completed",
        turnGeneration: 2,
        payload: { result: "authoritative" },
      }),
    ]);
  });

  test("rejects filters that could displace or exclude an exclusive latest lookup", async () => {
    for (const filters of [
      { includeTypes: ["machine.op.failed"] },
      { excludeTypes: ["turn.completed"] },
      { includeClasses: ["failure"] },
      { excludeClasses: ["terminal"] },
    ]) {
      await expect(
        callMcpTool("session_events", { sessionId, latest: "terminal", ...filters }),
      ).rejects.toThrow("latest cannot be combined with event filters");
    }
  });

  test("enforces the exact 64 KiB pretty-JSON model envelope", async () => {
    await appendSessionEvents(
      client.db,
      workspaceId,
      sessionId,
      Array.from({ length: 30 }, (_, index) => ({
        type: "agent.message.completed" as const,
        payload: { index, text: "x".repeat(7_000) },
      })),
    );
    const bounded = await callMcpTool<{
      events: Array<{ id: string; sequence: number }>;
      direction: "after";
      nextAfter: number;
      hasMore: boolean;
      truncated: boolean;
      truncation: { reasons: string[]; resumeCursor: number };
      bytes: number;
      maxBytes: number;
    }>("session_events", {
      sessionId,
      after: 44,
      limit: 40,
      mode: "forensic",
      payloadMode: "full",
    });

    expect(bounded.bytes).toBe(Buffer.byteLength(JSON.stringify(bounded, null, 2), "utf8"));
    expect(bounded.maxBytes).toBe(64 * 1024);
    expect(bounded.bytes).toBeLessThanOrEqual(bounded.maxBytes);
    expect(bounded.hasMore).toBeTrue();
    expect(bounded.truncated).toBeTrue();
    expect(bounded.truncation.reasons).toEqual(
      expect.arrayContaining(["model_payload", "model_bytes"]),
    );
    expect(bounded.nextAfter).toBe(bounded.events.at(-1)!.sequence);
    expect(bounded.truncation.resumeCursor).toBe(bounded.nextAfter);
    expect(
      bounded.events.every((event) => event.id !== "00000000-0000-0000-0000-000000000000"),
    ).toBeTrue();
  });
});
