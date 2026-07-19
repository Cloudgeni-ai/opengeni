// prepareToolspaceMcpSurface — the composed, session-scoped MCP surface a
// sandbox `toolspace:call` bearer sees. Driven against the REAL packages/db on a
// THROWAWAY postgres, with a real upstream MCP server (startTestMcpServer) so the
// listing/proxy path actually dials.
//
// Proves the review-hardening invariants:
//   - RECURSION GUARD: the first-party proxy ids (files/docs) are excluded from
//     the toolspace surface by construction, even when configured + selected, so
//     a toolspace principal can never re-enter /mcp as a first-party caller.
//   - NO UNBUDGETED FAN-OUT: a request with no active turn never dials upstreams
//     (the surface is empty), so list-type requests without a live turn cost zero
//     upstream connections.
//   - BUDGET vs TURN STATE: a call distinguishes "no active turn" from "budget
//     exhausted" in its typed error.
//   - GENERIC UPSTREAM ERROR: a failed upstream call returns a generic
//     "upstream tool failed" result naming the tool, never a raw error string.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import postgres from "postgres";
import {
  acquireSharedTestDatabase,
  startTestMcpServer,
  testSettings,
  MemoryEventBus,
  type SharedTestDatabase,
  type TestMcpServer,
} from "@opengeni/testing";
import type { Observability } from "@opengeni/observability";
import type { AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { createDb, createSession, type Database, type DbClient } from "@opengeni/db";
import {
  isToolspaceGrant,
  prepareToolspaceMcpSurface,
  ToolspaceToolListCache,
  toolspaceCanProxyServerId,
  type ToolListingEntry,
  type ToolspaceMcpSurface,
} from "../src/mcp/toolspace";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient | null = null;
let db: Database;
let upstream: TestMcpServer | null = null;

const warn = mock((_message: string, _attributes?: Record<string, unknown>) => {});
const observability = { warn } as unknown as Observability;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("toolspace-surface");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[toolspace-surface] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
  upstream = startTestMcpServer();
}, 180_000);

afterAll(async () => {
  upstream?.close();
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

function makeDeps(maxCallsPerTurn: number): ApiRouteDeps {
  const settings = testSettings({
    toolspaceEnabled: true,
    toolspaceMaxCallsPerTurn: maxCallsPerTurn,
    mcpServers: [
      { id: "thirdparty", url: upstream!.url, cacheToolsList: false },
      // A first-party proxy id, configured + reachable, as a recursion trap: if
      // the exclusion filter regressed, its tools would show up in the surface.
      { id: "files", url: upstream!.url, cacheToolsList: false },
    ],
  });
  return {
    settings,
    db,
    bus: new MemoryEventBus(),
    observability,
  } as unknown as ApiRouteDeps;
}

async function seedSession(input: { selects: string[]; withActiveTurn: boolean }): Promise<{
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
}> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  const session = await createSession(db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    initialMessage: "hi",
    resources: [],
    tools: input.selects.map((id) => ({ kind: "mcp", id })),
    metadata: {},
    model: "gpt-5.6-sol",
    sandboxBackend: "none",
  });
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  if (input.withActiveTurn) {
    await admin.begin(async (tx) => {
      await tx`
      insert into session_turns
        (id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
         status, position, prompt, model, reasoning_effort, sandbox_backend,
         execution_generation, active_attempt_id)
      values
        (${turnId}, ${account!.id}, ${workspace!.id}, ${session.id}, gen_random_uuid(), 'wf-1',
         'running', 0, 'hi', 'gpt-5.6-sol', 'medium', 'none', 1, ${attemptId})`;
      await tx`
        insert into session_turn_attempts
          (id, account_id, workspace_id, session_id, turn_id, execution_generation,
           state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
           verified_control_revision)
        values
          (${attemptId}, ${account!.id}, ${workspace!.id}, ${session.id}, ${turnId}, 1,
           'running', 'wf-1', ${`run:${attemptId}`}, ${`activity:${attemptId}`}, 0)`;
      await tx`update sessions set active_turn_id = ${turnId}, status = 'running' where id = ${session.id}`;
    });
  }
  return { workspaceId: workspace!.id, sessionId: session.id, turnId, attemptId };
}

function grantFor(
  workspaceId: string,
  sessionId: string,
  turnId: string,
  attemptId: string,
): AccessGrant {
  return {
    workspaceId,
    accountId: crypto.randomUUID(),
    subjectId: "sandbox:run-1",
    permissions: ["toolspace:call"],
    metadata: { sessionId, turnId, attemptId, executionGeneration: 1 },
  } as AccessGrant;
}

function toolNames(surface: ToolspaceMcpSurface): string[] {
  return surface.tools.map((tool) => tool.name).sort();
}

function cachedTool(serverId: string, description = "cached tool"): ToolListingEntry {
  return {
    serverId,
    tool: {
      name: "search",
      description,
      inputSchema: { type: "object", properties: {} },
    },
    requireApproval: false,
  };
}

describe("ToolspaceToolListCache", () => {
  test("evicts deterministically by LRU key order", () => {
    const cache = new ToolspaceToolListCache(2, 1024 * 1024, 1_000);
    expect(cache.write("a", [cachedTool("a")], 10)).toBe(true);
    expect(cache.write("b", [cachedTool("b")], 10)).toBe(true);
    expect(cache.read("a", 11)).not.toBeNull();
    expect(cache.write("c", [cachedTool("c")], 11)).toBe(true);
    expect(cache.snapshot().keys).toEqual(["a", "c"]);
    expect(cache.read("b", 11)).toBeNull();
  });

  test("honors an exact byte ceiling, rejects one-over entries, and expires safely", () => {
    const probe = new ToolspaceToolListCache(2, 1024 * 1024, 10);
    expect(probe.write("exact", [cachedTool("exact", "payload")], 100)).toBe(true);
    const exactBytes = probe.snapshot().bytes;

    const exact = new ToolspaceToolListCache(2, exactBytes, 10);
    expect(exact.write("exact", [cachedTool("exact", "payload")], 100)).toBe(true);
    expect(exact.snapshot().bytes).toBe(exactBytes);
    expect(exact.read("exact", 109)).not.toBeNull();
    expect(exact.read("exact", 110)).toBeNull();
    expect(exact.snapshot()).toEqual({ entries: 0, bytes: 0, keys: [] });

    const oneUnder = new ToolspaceToolListCache(2, exactBytes - 1, 10);
    expect(oneUnder.write("exact", [cachedTool("exact", "payload")], 100)).toBe(false);
    expect(oneUnder.snapshot()).toEqual({ entries: 0, bytes: 0, keys: [] });
  });
});

describe("toolspaceCanProxyServerId (recursion guard predicate)", () => {
  test("excludes the first-party tool server and the files/docs proxies", () => {
    expect(toolspaceCanProxyServerId("opengeni")).toBe(false);
    expect(toolspaceCanProxyServerId("files")).toBe(false);
    expect(toolspaceCanProxyServerId("docs")).toBe(false);
    expect(toolspaceCanProxyServerId("thirdparty")).toBe(true);
    expect(toolspaceCanProxyServerId("github-mcp")).toBe(true);
  });
});

describe("isToolspaceGrant", () => {
  const settings = testSettings({ toolspaceEnabled: true });
  const complete = grantFor(
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
  );

  test("requires session, turn, attempt, and execution-generation claims", () => {
    expect(isToolspaceGrant(settings, complete)).toBe(true);
    for (const missing of ["sessionId", "turnId", "attemptId", "executionGeneration"]) {
      expect(
        isToolspaceGrant(settings, {
          ...complete,
          metadata: Object.fromEntries(
            Object.entries(complete.metadata ?? {}).filter(([key]) => key !== missing),
          ),
        }),
      ).toBe(false);
    }
    for (const [key, value] of [
      ["sessionId", "not-a-uuid"],
      ["turnId", "not-a-uuid"],
      ["attemptId", "not-a-uuid"],
      ["executionGeneration", 0],
      ["executionGeneration", 1.5],
      ["executionGeneration", Number.NaN],
    ] as const) {
      expect(
        isToolspaceGrant(settings, {
          ...complete,
          metadata: { ...complete.metadata, [key]: value },
        }),
      ).toBe(false);
    }
  });
});

describe("prepareToolspaceMcpSurface", () => {
  test("lists third-party tools but excludes first-party proxies from the surface", async () => {
    if (!available) return;
    const { workspaceId, sessionId, turnId, attemptId } = await seedSession({
      selects: ["thirdparty", "files", "opengeni"],
      withActiveTurn: true,
    });
    const surface = await prepareToolspaceMcpSurface({
      deps: makeDeps(200),
      grant: grantFor(workspaceId, sessionId, turnId, attemptId),
    });
    expect(surface).not.toBeNull();
    const names = toolNames(surface!);
    expect(names).toContain("thirdparty__search_documents");
    expect(names).toContain("thirdparty__fetch_document");
    expect(names.some((name) => name.startsWith("files__"))).toBe(false);
    expect(names.some((name) => name.startsWith("opengeni"))).toBe(false);
    await surface!.close();
  }, 60_000);

  test("does not dial upstreams (empty surface) when there is no active turn", async () => {
    if (!available) return;
    const { workspaceId, sessionId, turnId, attemptId } = await seedSession({
      selects: ["thirdparty"],
      withActiveTurn: false,
    });
    const surface = await prepareToolspaceMcpSurface({
      deps: makeDeps(200),
      grant: grantFor(workspaceId, sessionId, turnId, attemptId),
    });
    expect(surface!.tools).toHaveLength(0);
    await surface!.close();
  }, 60_000);

  test("distinguishes no-active-turn from budget-exhausted on call", async () => {
    if (!available) return;
    const { workspaceId, sessionId, turnId, attemptId } = await seedSession({
      selects: ["thirdparty"],
      withActiveTurn: true,
    });
    const deps = makeDeps(1);
    const grant = grantFor(workspaceId, sessionId, turnId, attemptId);
    const surface = await prepareToolspaceMcpSurface({ deps, grant });
    const tool = surface!.tools.find((t) => t.name === "thirdparty__search_documents")!;
    expect(tool).toBeDefined();

    // First call reserves the only budget slot and succeeds.
    const ok = await tool.call({ query: "hello" });
    expect(ok.isError).toBeFalsy();

    // Second call: active turn still present, budget now exhausted.
    const exhausted = await tool.call({ query: "again" });
    expect(exhausted.isError).toBe(true);
    expect((exhausted.content?.[0] as { text?: string } | undefined)?.text).toContain(
      "budget exhausted",
    );

    // Clear the active turn: the message flips to the no-active-turn variant.
    await admin`update sessions set active_turn_id = null where id = ${sessionId}`;
    const noTurn = await tool.call({ query: "later" });
    expect(noTurn.isError).toBe(true);
    expect((noTurn.content?.[0] as { text?: string } | undefined)?.text).toContain(
      "no active turn",
    );
    await surface!.close();
  }, 60_000);

  test("returns a generic error (never the raw upstream error) when the upstream call fails", async () => {
    if (!available) return;
    const server = startTestMcpServer();
    const settings = testSettings({
      toolspaceEnabled: true,
      toolspaceMaxCallsPerTurn: 200,
      mcpServers: [{ id: "flaky", url: server.url, cacheToolsList: false }],
    });
    const deps = {
      settings,
      db,
      bus: new MemoryEventBus(),
      observability,
    } as unknown as ApiRouteDeps;
    const { workspaceId, sessionId, turnId, attemptId } = await seedSession({
      selects: ["flaky"],
      withActiveTurn: true,
    });
    const surface = await prepareToolspaceMcpSurface({
      deps,
      grant: grantFor(workspaceId, sessionId, turnId, attemptId),
    });
    const tool = surface!.tools.find((t) => t.name === "flaky__search_documents")!;
    expect(tool).toBeDefined();

    // Kill the upstream between listing (warm) and the call so the lazy per-call
    // connection fails; the sandbox must see a generic result, not a raw error.
    server.close();
    const result = await tool.call({ query: "boom" });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text;
    expect(text).toBe("upstream tool failed: flaky__search_documents");
    await surface!.close();
  }, 60_000);
});
