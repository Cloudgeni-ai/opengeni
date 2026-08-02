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
import type { AccessGrant, McpCredentialsRequest, SessionTurn } from "@opengeni/contracts";
import type { McpServerConfig } from "@opengeni/config";
import type { ApiRouteDeps } from "@opengeni/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createDb,
  createSession,
  createSessionMcpServers,
  listSessionEvents,
  mutateSessionControlInTransaction,
  settleSessionAttemptInterruptions,
  withWorkspaceRls,
  type CreateSessionMcpServerInput,
  type Database,
  type DbClient,
} from "@opengeni/db";
import {
  prepareToolspaceMcpSurface,
  connectionBrokerFetch,
  ToolspaceToolListCache,
  toolspaceCanProxyServerId,
  type ToolspaceMcpSurface,
} from "../src/mcp/toolspace";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

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
  sessionMcpServers?: CreateSessionMcpServerInput[];
}): Promise<{
  accountId: string;
  workspaceId: string;
  sessionId: string;
  rootSessionId: string;
  turnId: string | null;
  attemptId: string | null;
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
  if (input.sessionMcpServers?.length) {
    await createSessionMcpServers(db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sessionId: session.id,
      servers: input.sessionMcpServers,
    });
  }
  let attemptId: string | null = null;
  let turnId: string | null = null;
  if (input.withActiveTurn) {
    attemptId = crypto.randomUUID();
    const [turn] = await admin<{ id: string }[]>`
      insert into session_turns
        (account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
         status, position, prompt, model, reasoning_effort, sandbox_backend,
         execution_generation, initiator_kind, initiator_subject_id,
         initiator_context)
      values
        (${account!.id}, ${workspace!.id}, ${session.id}, gen_random_uuid(), 'wf-1',
         'running', 0, 'hi', 'gpt-5.6-sol', 'medium', 'none',
         3, 'subject', 'host:user:77', '{"source":"host-test"}'::jsonb)
      returning id`;
    turnId = turn!.id;
    const policies = Object.fromEntries(
      (input.sessionMcpServers ?? []).map((server) => [server.id, server.requireApproval ?? false]),
    );
    await admin`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies
      ) values (
        ${attemptId}, ${account!.id}, ${workspace!.id}, ${session.id}, ${turn!.id}, 3,
        'running', 'wf-1', ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0,
        ${JSON.stringify(policies)}::jsonb
      )`;
    await admin`
      update session_turns
      set active_attempt_id = ${attemptId}
      where id = ${turn!.id}`;
    await admin`
      update sessions
      set active_turn_id = ${turn!.id}
      where id = ${session.id}`;
  }
  return {
    accountId: account!.id,
    workspaceId: workspace!.id,
    sessionId: session.id,
    rootSessionId: root?.id ?? session.id,
    turnId,
    attemptId,
  };
}

function grantFor(input: {
  workspaceId: string;
  sessionId: string;
  accountId?: string;
}): AccessGrant {
  return {
    workspaceId: input.workspaceId,
    accountId: input.accountId ?? crypto.randomUUID(),
    subjectId: "sandbox:run-1",
    permissions: ["toolspace:call"],
    metadata: {
      sessionId: input.sessionId,
    },
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

describe("ToolspaceToolListCache", () => {
  test("does not admit an oversized listing after an aggregate failure", () => {
    const cache = new ToolspaceToolListCache(4, 256, 1_000);
    const oversized = [
      {
        serverId: "overflow",
        tool: { name: "large", description: "x".repeat(512) },
        requireApproval: false,
      },
    ];
    expect(cache.write("aggregate-failure", oversized)).toBe(false);
    expect(cache.read("aggregate-failure")).toBeNull();
    expect(cache.snapshot()).toEqual({ entries: 0, bytes: 0, keys: [] });
  });

  test("keeps a safe value when an oversized same-key replacement is rejected", () => {
    const cache = new ToolspaceToolListCache(4, 256, 1_000);
    const safe = [
      {
        serverId: "safe",
        tool: { name: "small", description: "ok" },
        requireApproval: false,
      },
    ];
    const oversized = [
      {
        serverId: "unsafe",
        tool: { name: "large", description: "x".repeat(512) },
        requireApproval: false,
      },
    ];

    expect(cache.write("same-key", safe)).toBe(true);
    expect(cache.write("same-key", oversized)).toBe(false);
    expect(cache.read("same-key")).toEqual(safe);
  });
});

describe("connectionBrokerFetch response lifecycle", () => {
  test("cancels superseded 401 bodies before refreshing and classifying auth", async () => {
    const canceled: string[] = [];
    const responseWithTrackedBody = (status: number, label: string): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(label));
          },
          cancel() {
            canceled.push(label);
          },
        }),
        { status },
      );
    let fetchCount = 0;
    const baseFetch = async () => {
      fetchCount += 1;
      switch (fetchCount) {
        case 1:
          return responseWithTrackedBody(401, "initial-401");
        case 2:
          return responseWithTrackedBody(200, "retry-200");
        case 3:
          return responseWithTrackedBody(401, "initial-401-again");
        case 4:
          return responseWithTrackedBody(401, "retry-401");
        default:
          return responseWithTrackedBody(403, "initial-403");
      }
    };
    const credentialRequests: McpCredentialsRequest[] = [];
    const connectionRef = {
      provider: "test-provider",
      providerDomain: "example.com",
      connectionId: "connection-1",
    } as const;
    const deps = {
      connectionCredentials: {
        mcpCredentials: async (request: McpCredentialsRequest) => {
          credentialRequests.push(request);
          return {
            status: "ok" as const,
            accountId: request.accountId,
            workspaceId: request.workspaceId,
            sessionId: request.sessionId,
            headers: { Authorization: `Bearer ${request.forceRefresh ? "refresh" : "first"}` },
            connectionId: "connection-1",
            provider: "test-provider",
            providerDomain: "example.com",
          };
        },
      },
    } as unknown as ApiRouteDeps;
    const broker = connectionBrokerFetch(baseFetch, {
      deps,
      grant: {
        accountId: "account-1",
        workspaceId: "workspace-1",
        subjectId: "sandbox:test",
        permissions: ["toolspace:call"],
        metadata: {
          sessionId: "session-1",
          turnId: "turn-1",
          attemptId: "attempt-1",
          executionGeneration: 1,
        },
      } as AccessGrant,
      config: {
        id: "test-server",
        url: "https://example.com/mcp",
        cacheToolsList: false,
        connectionRef,
      } as McpServerConfig,
      sessionId: "session-1",
      rootSessionId: "session-1",
      turn: {
        id: "turn-1",
        activeAttemptId: "attempt-1",
        executionGeneration: 1,
        initiator: { kind: "subject", subjectId: "host:test" },
        initiatorContext: {},
      } as SessionTurn,
    });

    const result = await broker("https://example.com/mcp", { method: "GET" });
    expect(result.status).toBe(200);
    const expired = await broker("https://example.com/mcp", { method: "GET" });
    expect(expired.status).toBe(401);
    const insufficient = await broker("https://example.com/mcp", { method: "GET" });
    expect(insufficient.status).toBe(401);
    expect(fetchCount).toBe(5);
    expect(credentialRequests.length).toBeGreaterThan(1);
    expect(credentialRequests.every((request) => request.callerSubjectId === "sandbox:test")).toBe(
      true,
    );
    expect(canceled).toEqual(["initial-401", "initial-401-again", "retry-401", "initial-403"]);
  });
});

describe("prepareToolspaceMcpSurface", () => {
  test("service turns degrade subject-owned MCPs without reaching credentials or transport", async () => {
    let fetchCalls = 0;
    const baseFetch = async () => {
      fetchCalls += 1;
      return new Response("unexpected");
    };
    const broker = connectionBrokerFetch(baseFetch, {
      deps: { settings: testSettings() } as ApiRouteDeps,
      grant: {
        accountId: "account-1",
        workspaceId: "workspace-1",
        subjectId: "sandbox:scheduled",
        permissions: ["toolspace:call"],
      } as AccessGrant,
      config: {
        id: "personal-slack",
        url: "https://mcp.slack.com/mcp",
        cacheToolsList: false,
        connectionRef: {
          providerDomain: "slack.com",
          kind: "oauth2",
          subjectScope: "subject",
        },
      } as McpServerConfig,
      sessionId: "session-1",
      rootSessionId: "session-1",
      turn: {
        id: "turn-1",
        activeAttemptId: "attempt-1",
        executionGeneration: 1,
        initiator: { kind: "service", subjectId: "scheduler" },
        initiatorContext: {},
      } as SessionTurn,
    });
    const response = await broker("https://mcp.slack.com/mcp", { method: "GET" });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("Authentication required");
    expect(fetchCalls).toBe(0);
  });

  test("an empty Toolspace surface returns a valid empty tools/list", async () => {
    if (!available) return;
    const server = buildOpenGeniMcpServer(
      makeDeps(200),
      grantFor({
        accountId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
      }),
      {
        toolspace: {
          sessionId: crypto.randomUUID(),
          subjectId: "sandbox:empty",
          tools: [],
          close: async () => {},
        },
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "empty-toolspace-test", version: "1" });
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    try {
      expect((await mcpClient.listTools()).tools).toEqual([]);
    } finally {
      await Promise.all([mcpClient.close(), server.close()]);
    }
  });

  test("uses host MCP credentials and preserves legitimate auth-needed results", async () => {
    if (!available) return;
    const server = startTestMcpServer({ requiredAuthorization: "Bearer cloud-connection" });
    const connectionId = crypto.randomUUID();
    const requests: McpCredentialsRequest[] = [];
    let authRequired = false;
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
      sessionMcpServers: [
        {
          id: "host-github",
          url: server.url,
          cacheToolsList: false,
          connectionRef: {
            connectionId,
            provider: "github",
            providerDomain: new URL(server.url).hostname,
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
          if (authRequired && request.toolName) {
            return {
              status: "auth_needed" as const,
              accountId: request.accountId,
              workspaceId: request.workspaceId,
              sessionId: request.sessionId,
              reason: "missing_connection" as const,
              connectionId,
              providerDomain: request.connectionRef.providerDomain,
              ...(request.connectionRef.provider
                ? { provider: request.connectionRef.provider }
                : {}),
              ...(request.connectionRef.selectedResources
                ? { selectedResources: request.connectionRef.selectedResources }
                : {}),
              authorizationUrl: "https://example.com/connect",
            };
          }
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
      grant: grantFor(seeded),
    });
    const tool = surface!.tools.find(
      (candidate) => candidate.name === "host-github__search_documents",
    );
    expect(tool).toBeDefined();
    const result = await tool!.call({ query: "host credential" });
    expect(result.isError).toBeFalsy();
    authRequired = true;
    const authResult = await tool!.call({ query: "reauthenticate" });
    expect(authResult).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: "Authentication required - a connection link was posted to the session.",
        },
      ],
    });
    expect(server.calls).toHaveLength(1);
    const events = await listSessionEvents(db, seeded.workspaceId, seeded.sessionId, 0, 100);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.auth_needed",
        payload: expect.objectContaining({
          serverId: "host-github",
          toolName: "search_documents",
          reason: "missing_connection",
          connectionId,
          authorizationUrl: "https://example.com/connect",
        }),
      }),
    );
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.surface === "toolspace")).toBe(true);
    expect(requests.every((request) => request.accountId === seeded.accountId)).toBe(true);
    expect(requests.every((request) => request.workspaceId === seeded.workspaceId)).toBe(true);
    expect(requests.every((request) => request.sessionId === seeded.sessionId)).toBe(true);
    expect(requests.every((request) => request.rootSessionId === seeded.rootSessionId)).toBe(true);
    expect(requests.every((request) => request.executionGeneration === 3)).toBe(true);
    expect(requests.every((request) => request.attemptId === seeded.attemptId)).toBe(true);
    expect(requests.every((request) => request.callerSubjectId === "sandbox:run-1")).toBe(true);
    expect(
      requests.every((request) => request.destinationUrl === new URL(server.url).toString()),
    ).toBe(true);
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
    const seeded = await seedSession({
      selects: ["thirdparty", "files", "opengeni"],
      withActiveTurn: true,
    });
    const surface = await prepareToolspaceMcpSurface({
      deps: makeDeps(200),
      grant: grantFor(seeded),
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
    const seeded = await seedSession({
      selects: ["thirdparty"],
      withActiveTurn: false,
    });
    const surface = await prepareToolspaceMcpSurface({
      deps: makeDeps(200),
      grant: grantFor(seeded),
    });
    expect(surface!.tools).toHaveLength(0);
    await surface!.close();
  }, 60_000);

  test("does not dial upstreams while the owned turn is recovering", async () => {
    if (!available) return;
    const seeded = await seedSession({
      selects: ["thirdparty"],
      withActiveTurn: true,
    });
    await admin`
      update session_turns
      set status = 'recovering'
      where id = ${seeded.turnId}`;
    const callsBefore = upstream!.calls.length;
    const surface = await prepareToolspaceMcpSurface({
      deps: makeDeps(200),
      grant: grantFor(seeded),
    });
    expect(surface!.tools).toHaveLength(0);
    expect(upstream!.calls).toHaveLength(callsBefore);
    await surface!.close();
  }, 60_000);

  test("distinguishes no-active-turn from budget-exhausted on call", async () => {
    if (!available) return;
    const seeded = await seedSession({
      selects: ["thirdparty"],
      withActiveTurn: true,
    });
    const deps = makeDeps(1);
    const grant = grantFor(seeded);
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
    await admin`update sessions set active_turn_id = null where id = ${seeded.sessionId}`;
    const noTurn = await tool.call({ query: "later" });
    expect(noTurn.isError).toBe(true);
    expect((noTurn.content?.[0] as { text?: string } | undefined)?.text).toContain(
      "no active turn",
    );
    await surface!.close();
  }, 60_000);

  test("one session bearer resolves a successor attempt while a stale surface remains fenced", async () => {
    if (!available) return;
    const seeded = await seedSession({
      selects: ["thirdparty"],
      withActiveTurn: true,
    });
    const deps = makeDeps(200);
    const staleSurface = await prepareToolspaceMcpSurface({
      deps,
      grant: grantFor(seeded),
    });
    const staleTool = staleSurface!.tools.find(
      (tool) => tool.name === "thirdparty__search_documents",
    );
    expect(staleTool).toBeDefined();

    const successorAttemptId = crypto.randomUUID();
    await admin`
      update session_turn_attempts
      set state = 'closed', outcome = 'interrupted_recoverable', closed_at = now()
      where id = ${seeded.attemptId}`;
    await admin`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies
      ) values (
        ${successorAttemptId}, ${seeded.accountId}, ${seeded.workspaceId},
        ${seeded.sessionId}, ${seeded.turnId}, 3, 'running', 'wf-1',
        ${`run-${successorAttemptId}`}, ${`activity-${successorAttemptId}`}, 0,
        '{}'::jsonb
      )`;
    await admin`
      update session_turns
      set active_attempt_id = ${successorAttemptId}
      where id = ${seeded.turnId}`;

    const callsBeforeStaleUse = upstream!.calls.length;
    const rejected = await staleTool!.call({ query: "must not cross attempts" });
    expect(rejected.isError).toBe(true);
    expect((rejected.content?.[0] as { text?: string } | undefined)?.text).toContain(
      "no active turn",
    );
    expect(upstream!.calls).toHaveLength(callsBeforeStaleUse);

    const successorSurface = await prepareToolspaceMcpSurface({
      deps,
      grant: grantFor(seeded),
    });
    const successorTool = successorSurface!.tools.find(
      (tool) => tool.name === "thirdparty__search_documents",
    );
    const accepted = await successorTool!.call({ query: "successor owns this" });
    expect(accepted.isError).toBeFalsy();
    expect(upstream!.calls).toHaveLength(callsBeforeStaleUse + 1);
    await staleSurface!.close();
    await successorSurface!.close();
  }, 60_000);

  test("an interrupted in-flight call records unknown and rejects its late output", async () => {
    if (!available) return;
    let markStarted: (() => void) | null = null;
    let releaseCall: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    const server = startTestMcpServer({
      beforeToolCall: async () => {
        markStarted?.();
        await gate;
      },
    });
    const deps = {
      settings: testSettings({
        toolspaceEnabled: true,
        toolspaceMaxCallsPerTurn: 200,
        mcpServers: [{ id: "gated", url: server.url, cacheToolsList: false }],
      }),
      db,
      bus: new MemoryEventBus(),
      observability,
    } as unknown as ApiRouteDeps;
    const seeded = await seedSession({
      selects: ["gated"],
      withActiveTurn: true,
    });
    const surface = await prepareToolspaceMcpSurface({
      deps,
      grant: grantFor(seeded),
    });
    const tool = surface!.tools.find((candidate) => candidate.name === "gated__search_documents");
    expect(tool).toBeDefined();

    const pendingCall = tool!.call({ query: "in flight" });
    await started;
    const paused = await withWorkspaceRls(db, seeded.workspaceId, (scopedDb) =>
      scopedDb.transaction((tx) =>
        mutateSessionControlInTransaction(tx as unknown as Database, {
          accountId: seeded.accountId,
          workspaceId: seeded.workspaceId,
          sessionId: seeded.sessionId,
          actor: { type: "human", subjectId: "host:user:77" },
          operationKey: crypto.randomUUID(),
          action: "pause",
          reason: "test interruption",
        }),
      ),
    );
    expect(paused.interruptionCount).toBe(1);
    const settlement = await settleSessionAttemptInterruptions(
      db,
      seeded.workspaceId,
      seeded.sessionId,
      seeded.attemptId!,
    );
    const unknownOutput = settlement.events.find((event) => event.type === "agent.toolCall.output");
    expect(unknownOutput?.payload).toMatchObject({
      recovery: {
        interrupted: true,
        outcome: "unknown",
        reason: "session_pause",
      },
    });

    releaseCall?.();
    await pendingCall;
    const events = await listSessionEvents(db, seeded.workspaceId, seeded.sessionId, 0, 100);
    const authoritativeOutputs = events.filter((event) => event.type === "agent.toolCall.output");
    expect(authoritativeOutputs).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.type === "turn.event.rejected_late" &&
          (event.payload as { rejectedType?: unknown }).rejectedType === "agent.toolCall.output",
      ),
    ).toBe(true);
    await surface!.close();
    server.close();
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
    const seeded = await seedSession({
      selects: ["flaky"],
      withActiveTurn: true,
    });
    const surface = await prepareToolspaceMcpSurface({
      deps,
      grant: grantFor(seeded),
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

  test("never turns an MCP request timeout into a connection-auth result", async () => {
    if (!available) return;
    let markStarted: (() => void) | null = null;
    let releaseCall: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    const server = startTestMcpServer({
      beforeToolCall: async () => {
        markStarted?.();
        await gate;
      },
    });
    const deps = {
      settings: testSettings({
        toolspaceEnabled: true,
        toolspaceMaxCallsPerTurn: 200,
        mcpServers: [
          {
            id: "timeout",
            url: server.url,
            cacheToolsList: false,
            timeoutMs: 1_000,
          },
        ],
      }),
      db,
      bus: new MemoryEventBus(),
      observability,
    } as unknown as ApiRouteDeps;
    const seeded = await seedSession({
      selects: ["timeout"],
      withActiveTurn: true,
    });
    let surface: ToolspaceMcpSurface | null = null;
    try {
      surface = await prepareToolspaceMcpSurface({
        deps,
        grant: grantFor(seeded),
      });
      const tool = surface!.tools.find(
        (candidate) => candidate.name === "timeout__search_documents",
      );
      expect(tool).toBeDefined();
      const pending = tool!.call({ query: "wait" });
      await started;
      const result = await pending;
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "upstream tool failed: timeout__search_documents" }],
      });
      const events = await listSessionEvents(db, seeded.workspaceId, seeded.sessionId, 0, 100);
      expect(events.some((event) => event.type === "tool.auth_needed")).toBe(false);
    } finally {
      releaseCall?.();
      await surface?.close();
      server.close();
    }
  }, 60_000);
});
