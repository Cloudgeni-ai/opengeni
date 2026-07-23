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
import type { AccessGrant, McpCredentialsRequest } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  createDb,
  createSession,
  createSessionMcpServers,
  type Database,
  type DbClient,
} from "@opengeni/db";
import {
  prepareToolspaceMcpSurface,
  toolspaceCanProxyServerId,
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

async function seedSession(input: {
  selects: string[];
  withActiveTurn: boolean;
  child?: boolean;
}): Promise<{
  accountId: string;
  workspaceId: string;
  sessionId: string;
  rootSessionId: string;
}> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  const root = input.child
    ? await createSession(db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        initialMessage: "root",
        resources: [],
        tools: [],
        metadata: {},
        model: "gpt-5.6-sol",
        sandboxBackend: "none",
      })
    : null;
  const session = await createSession(db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    initialMessage: "hi",
    resources: [],
    tools: input.selects.map((id) => ({ kind: "mcp", id })),
    metadata: {},
    model: "gpt-5.6-sol",
    sandboxBackend: "none",
    parentSessionId: root?.id ?? null,
  });
  if (input.withActiveTurn) {
    const [turn] = await admin<{ id: string }[]>`
      insert into session_turns
        (account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
         status, position, prompt, model, reasoning_effort, sandbox_backend,
         execution_generation, initiator_kind, initiator_subject_id, initiator_context)
      values
        (${account!.id}, ${workspace!.id}, ${session.id}, gen_random_uuid(), 'wf-1',
         'running', 0, 'hi', 'gpt-5.6-sol', 'medium', 'none',
         3, 'subject', 'host:user:77', '{"source":"host-test"}'::jsonb)
      returning id`;
    await admin`update sessions set active_turn_id = ${turn!.id} where id = ${session.id}`;
  }
  return {
    accountId: account!.id,
    workspaceId: workspace!.id,
    sessionId: session.id,
    rootSessionId: root?.id ?? session.id,
  };
}

function grantFor(
  workspaceId: string,
  sessionId: string,
  accountId = crypto.randomUUID(),
): AccessGrant {
  return {
    workspaceId,
    accountId,
    subjectId: "sandbox:run-1",
    permissions: ["toolspace:call"],
    metadata: { sessionId },
  } as AccessGrant;
}

function toolNames(surface: ToolspaceMcpSurface): string[] {
  return surface.tools.map((tool) => tool.name).sort();
}

describe("toolspaceCanProxyServerId (recursion guard predicate)", () => {
  test("excludes the first-party tool server and the files/docs proxies", () => {
    expect(toolspaceCanProxyServerId("opengeni")).toBe(false);
    expect(toolspaceCanProxyServerId("files")).toBe(false);
    expect(toolspaceCanProxyServerId("docs")).toBe(false);
    expect(toolspaceCanProxyServerId("thirdparty")).toBe(true);
    expect(toolspaceCanProxyServerId("github-mcp")).toBe(true);
  });
});

describe("prepareToolspaceMcpSurface", () => {
  test("uses the host MCP credential port with the active turn's frozen initiator", async () => {
    if (!available) return;
    const server = startTestMcpServer({ requiredAuthorization: "Bearer cloud-connection" });
    const connectionId = crypto.randomUUID();
    const requests: McpCredentialsRequest[] = [];
    const settings = testSettings({
      toolspaceEnabled: true,
      toolspaceMaxCallsPerTurn: 200,
      environmentsEncryptionKey: undefined,
      mcpServers: [],
    });
    const seeded = await seedSession({
      selects: ["host-github"],
      withActiveTurn: true,
      child: true,
    });
    await createSessionMcpServers(db, {
      accountId: seeded.accountId,
      workspaceId: seeded.workspaceId,
      sessionId: seeded.sessionId,
      servers: [
        {
          id: "host-github",
          url: server.url,
          cacheToolsList: false,
          connectionRef: {
            connectionId,
            provider: "github",
            providerDomain: "github.com",
            kind: "app_install",
            selectedResources: [{ kind: "repository", id: "9001" }],
          },
        },
      ],
    });
    const deps = {
      settings,
      db,
      bus: new MemoryEventBus(),
      observability,
      connectionCredentials: {
        mcpCredentials: async (request: McpCredentialsRequest) => {
          requests.push(request);
          return {
            status: "ok" as const,
            accountId: request.accountId,
            workspaceId: request.workspaceId,
            sessionId: request.sessionId,
            headers: { Authorization: "Bearer cloud-connection" },
            connectionId,
            providerDomain: request.connectionRef.providerDomain,
            ...(request.connectionRef.provider ? { provider: request.connectionRef.provider } : {}),
            ...(request.connectionRef.selectedResources
              ? { selectedResources: request.connectionRef.selectedResources }
              : {}),
          };
        },
      },
    } as unknown as ApiRouteDeps;
    const surface = await prepareToolspaceMcpSurface({
      deps,
      grant: grantFor(seeded.workspaceId, seeded.sessionId, seeded.accountId),
    });
    const tool = surface!.tools.find(
      (candidate) => candidate.name === "host-github__search_documents",
    );
    expect(tool).toBeDefined();
    const result = await tool!.call({ query: "host credential" });
    expect(result.isError).toBeFalsy();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.surface === "toolspace")).toBe(true);
    expect(requests.every((request) => request.accountId === seeded.accountId)).toBe(true);
    expect(requests.every((request) => request.workspaceId === seeded.workspaceId)).toBe(true);
    expect(requests.every((request) => request.sessionId === seeded.sessionId)).toBe(true);
    expect(requests.every((request) => request.rootSessionId === seeded.rootSessionId)).toBe(true);
    expect(requests.every((request) => request.executionGeneration === 3)).toBe(true);
    expect(requests.every((request) => request.attemptId === null)).toBe(true);
    expect(requests.every((request) => request.callerSubjectId === "sandbox:run-1")).toBe(true);
    expect(
      requests.every(
        (request) =>
          JSON.stringify(request.initiator) ===
          JSON.stringify({
            kind: "subject",
            subjectId: "host:user:77",
          }),
      ),
    ).toBe(true);
    expect(requests.some((request) => request.toolName === "search_documents")).toBe(true);
    await surface!.close();
    server.close();
  }, 60_000);

  test("lists third-party tools but excludes first-party proxies from the surface", async () => {
    if (!available) return;
    const { workspaceId, sessionId } = await seedSession({
      selects: ["thirdparty", "files", "opengeni"],
      withActiveTurn: true,
    });
    const surface = await prepareToolspaceMcpSurface({
      deps: makeDeps(200),
      grant: grantFor(workspaceId, sessionId),
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
    const { workspaceId, sessionId } = await seedSession({
      selects: ["thirdparty"],
      withActiveTurn: false,
    });
    const surface = await prepareToolspaceMcpSurface({
      deps: makeDeps(200),
      grant: grantFor(workspaceId, sessionId),
    });
    expect(surface!.tools).toHaveLength(0);
    await surface!.close();
  }, 60_000);

  test("distinguishes no-active-turn from budget-exhausted on call", async () => {
    if (!available) return;
    const { workspaceId, sessionId } = await seedSession({
      selects: ["thirdparty"],
      withActiveTurn: true,
    });
    const deps = makeDeps(1);
    const grant = grantFor(workspaceId, sessionId);
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
    const { workspaceId, sessionId } = await seedSession({
      selects: ["flaky"],
      withActiveTurn: true,
    });
    const surface = await prepareToolspaceMcpSurface({
      deps,
      grant: grantFor(workspaceId, sessionId),
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
