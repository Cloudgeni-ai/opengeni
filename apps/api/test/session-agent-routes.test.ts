import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  signDelegatedAccessToken,
  type FirstPartyMcpToolName,
  type Permission,
  type Session,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSession,
  initializeSessionStartAtomically,
  listSessionEvents,
  updateWorkspaceSettings,
  type DbClient,
} from "@opengeni/db";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { withMcpClient } from "./helpers/first-party-tool-client";

// Agent configuration on the public session API: create, PUT .../agent with the
// shared tool-policy CAS, typed 422s, the omitted-agent default, MCP child
// narrowing, and previously mutable endpoints.

const SECRET = "agent-config-route-test-secret";
const ENVIRONMENTS_ENCRYPTION_KEY = Buffer.alloc(32, 43).toString("base64");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const AGENT_PERMISSIONS: Permission[] = [
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "goals:manage",
  "workspace:read",
];
const RUNTIME_TOOLS = ["command_read", "command_wait", "set_session_title", "wait_for_input"];

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

setDefaultTimeout(60_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-session-agent-routes");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Grant = Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];
function settings() {
  return testSettings({
    productAccessMode: "managed",
    delegationSecret: SECRET,
    environmentsEncryptionKey: ENVIRONMENTS_ENCRYPTION_KEY,
    sandboxBackend: "none",
  });
}

function routeDeps(): ApiRouteDeps {
  const noop = async () => undefined;
  return {
    settings: settings(),
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
    githubStateSecret: "test",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps;
}

function app(): Hono {
  const deps = routeDeps();
  return createApp({
    settings: deps.settings,
    db: client.db,
    bus: deps.bus,
    workflowClient: deps.workflowClient,
  } as Parameters<typeof createApp>[0]);
}

async function fixture(): Promise<Grant> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "agent-config-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Agent config routes",
    workspaceExternalSource: "agent-config-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Agent config routes",
    subjectId: `user:${suffix}`,
  });
  return access.workspaceGrants[0]!;
}

async function humanBearer(grant: Grant): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: ["sessions:read", "sessions:control", "sessions:create", "goals:manage"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

async function request(
  target: Hono,
  bearer: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const response = await target.request(path, {
    method,
    headers: { authorization: bearer, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

async function create(target: Hono, grant: Grant, body: Record<string, unknown>) {
  return await request(
    target,
    await humanBearer(grant),
    "POST",
    `/v1/workspaces/${grant.workspaceId}/sessions`,
    { initialMessage: "hello", resources: [], ...body },
  );
}

async function putAgent(
  target: Hono,
  bearer: string,
  grant: Grant,
  sessionId: string,
  body: unknown,
) {
  return await request(
    target,
    bearer,
    "PUT",
    `/v1/workspaces/${grant.workspaceId}/sessions/${sessionId}/agent`,
    body,
  );
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe("agent configuration client config and MCP (real PostgreSQL)", () => {
  test("client config always reports agent configuration on", async () => {
    if (!available) return;
    const grant = await fixture();
    const config = await request(app(), await humanBearer(grant), "GET", "/v1/config/client");
    expect(config.json.agentConfig).toMatchObject({ enabled: true, defaultForNewSessions: true });
    expect(config.json.agentConfig.capabilities).toHaveLength(13);
  });

  test("MCP session_create exposes optional agent selection", async () => {
    if (!available) return;
    const grant = await fixture();
    const root = await rootSession(grant, null);
    const attempt = await liveAttempt(grant, root.id);
    const discoverSchema = async () => {
      const server = buildOpenGeniMcpServer(
        routeDeps(),
        agentGrant(grant, attempt, ["session_create"]),
      );
      return withMcpClient(server, async (mcpClient) => {
        const tool = (await mcpClient.listTools()).tools.find(
          (entry) => entry.name === "session_create",
        );
        expect(tool).toBeDefined();
        return tool!.inputSchema;
      });
    };
    const schema = await discoverSchema();
    expect(schema.properties).toHaveProperty("initialMessage");
    expect(schema.required).toContain("initialMessage");
    expect(schema.required).not.toContain("agent");
    expect(schema.properties!.agent).toMatchObject({
      type: "object",
      properties: { capabilities: { anyOf: expect.any(Array) } },
    });
  });
});

describe("agent configuration on create (real PostgreSQL)", () => {
  test('"all" matches an omitted agent exactly; "none" keeps runtime mechanics', async () => {
    if (!available) return;
    const grant = await fixture();
    const target = app();
    const omitted = await create(target, grant, {});
    const all = await create(target, grant, { agent: { capabilities: "all" } });
    expect(all.status).toBe(202);
    expect(all.json.agent).toMatchObject({ version: 1, from: "all", source: "request" });
    expect(all.json.firstPartyMcpTools).toEqual(omitted.json.firstPartyMcpTools);
    expect(all.json.tools).toEqual(omitted.json.tools);
    expect(all.json.toolPolicy).toEqual(omitted.json.toolPolicy);
    expect(all.json.effectiveTools.capabilities.goals).toBe(true);

    const none = await create(target, grant, { agent: { capabilities: "none" } });
    expect(none.status).toBe(202);
    expect(sorted(none.json.firstPartyMcpTools)).toEqual(RUNTIME_TOOLS);
    expect(none.json.toolPolicy.mode).toBe("explicit");
    // No workspace connectors or built-in files/docs servers; the mandatory
    // first-party server is attached at runtime.
    expect(none.json.tools).toEqual([]);
    const names = none.json.effectiveTools.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("request_human_input");
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("list_models");
  });

  test("typed 422s: goal conflict, instructions alias conflict, explicit tool conflict", async () => {
    if (!available) return;
    const grant = await fixture();
    const target = app();
    const goalConflict = await create(target, grant, {
      goal: { text: "Ship it" },
      agent: { capabilities: { from: "all", goals: false } },
    });
    expect(goalConflict.status).toBe(422);
    expect(goalConflict.json.details).toMatchObject({
      code: "agent_config_conflict",
      capability: "goals",
    });
    const alias = await create(target, grant, {
      instructions: "a",
      agent: { instructions: "b" },
    });
    expect(alias.json.details.code).toBe("agent_config_conflict");
    const explicit = await create(target, grant, {
      firstPartyMcpTools: ["goal_set"],
      agent: { capabilities: "none" },
    });
    expect(explicit.json.details.code).toBe("agent_config_conflict");
  });

  test("a goal implies goals; instructions alias writes the session instructions", async () => {
    if (!available) return;
    const grant = await fixture();
    const target = app();
    const created = await create(target, grant, {
      goal: { text: "Ship it" },
      agent: { capabilities: "none", instructions: "Answer briefly.", identity: "Acme" },
    });
    expect(created.status).toBe(202);
    expect(created.json.agent.capabilities.goals).toBe(true);
    expect(created.json.agent.identity).toBe("Acme");
    expect(created.json.instructions).toBe("Answer briefly.");
    expect(created.json.firstPartyMcpTools).toContain("goal_complete");
  });

  test("an omitted agent resolves to all with the default tools", async () => {
    if (!available) return;
    const grant = await fixture();
    const defaulted = await create(app(), grant, {});
    expect(defaulted.json.agent).toMatchObject({ from: "all", source: "deployment_default" });
    expect(sorted(defaulted.json.firstPartyMcpTools)).toEqual(
      sorted(DEFAULT_FIRST_PARTY_MCP_TOOLS),
    );
  });

  test("workspace defaults apply to an omitted agent", async () => {
    if (!available) return;
    const grant = await fixture();
    await updateWorkspaceSettings(client.db, grant.workspaceId, {
      sessionAgentDefaults: { capabilities: { from: "none", knowledge: true }, identity: "Ws bot" },
    });
    const created = await create(app(), grant, {});
    expect(created.json.agent).toMatchObject({
      source: "workspace_default",
      identity: "Ws bot",
    });
    expect(created.json.agent.capabilities.knowledge).toBe(true);
    expect(created.json.firstPartyMcpTools).toContain("knowledge_search");
    expect(created.json.firstPartyMcpTools).not.toContain("goal_set");
  });
});

describe("PUT .../agent (real PostgreSQL)", () => {
  test("CAS, next-attempt event, stale 409, human widening adds tools back", async () => {
    if (!available) return;
    const grant = await fixture();
    const target = app();
    const bearer = await humanBearer(grant);
    const created = await create(target, grant, { agent: { capabilities: "none" } });
    const sessionId = created.json.id as string;
    const version = created.json.toolPolicyVersion as number;

    const updated = await putAgent(target, bearer, grant, sessionId, {
      agent: { capabilities: { from: "none", goals: true }, renderer: "markdown" },
      expectedVersion: version,
    });
    expect(updated.status).toBe(200);
    expect(updated.json.toolPolicyVersion).toBe(version + 1);
    expect(updated.json.agent).toMatchObject({ renderer: "markdown", source: "request" });
    expect(updated.json.agent.capabilities.goals).toBe(true);
    expect(updated.json.firstPartyMcpTools).toContain("goal_set");

    const events = await listSessionEvents(client.db, grant.workspaceId, sessionId);
    const event = events.find((candidate) => candidate.type === "session.agent.updated");
    expect(event?.payload).toMatchObject({ version: version + 1, effectiveFrom: "next_attempt" });

    const stale = await putAgent(target, bearer, grant, sessionId, {
      agent: { capabilities: "none" },
      expectedVersion: version,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.currentVersion).toBe(version + 1);

    // Omitted fields keep current values; the instructions alias writes through.
    const identity = await putAgent(target, bearer, grant, sessionId, {
      agent: { identity: "Helper", instructions: "One sentence." },
      expectedVersion: version + 1,
    });
    expect(identity.json.agent).toMatchObject({ identity: "Helper", renderer: "markdown" });
    expect(identity.json.instructions).toBe("One sentence.");
  });

  test("a legacy session converts from its current effective state without widening", async () => {
    if (!available) return;
    const grant = await fixture();
    const target = app();
    // Sessions created before agent configuration keep a null config.
    const legacy = await rootSession(grant, null, [
      "set_session_title",
      "wait_for_input",
      "goal_set",
      "goal_update",
    ]);
    const converted = await putAgent(target, await humanBearer(grant), grant, legacy.id, {
      agent: { identity: "Converted" },
      expectedVersion: legacy.toolPolicyVersion,
    });
    expect(converted.status).toBe(200);
    expect(converted.json.agent.source).toBe("legacy_conversion");
    expect(converted.json.agent.capabilities.goals).toBe(true);
    expect(converted.json.agent.capabilities.knowledge).toBe(false);
    expect(converted.json.agent.capabilities.schedules).toBe(false);
    expect(sorted(converted.json.firstPartyMcpTools)).toEqual(
      sorted(["set_session_title", "wait_for_input", "goal_set", "goal_update"]),
    );
  });

  test("an agent may only narrow its own session", async () => {
    if (!available) return;
    const grant = await fixture();
    const root = await rootSession(grant, {
      version: 1,
      from: "none",
      capabilities: {
        webSearch: false,
        humanInput: true,
        skills: "read",
        goals: false,
        subagents: true,
        knowledge: false,
        schedules: false,
        artifacts: false,
        browser: false,
        media: false,
        workspaceFiles: false,
        workspaceConnectors: false,
        workspaceAdmin: false,
      },
      unavailable: [],
      identity: null,
      renderer: "opengeni",
      source: "request",
    });
    const attempt = await liveAttempt(grant, root.id);
    const bearer = await agentBearer(grant, attempt, root.firstPartyMcpTools);
    const target = app();
    const widened = await putAgent(target, bearer, grant, root.id, {
      agent: { capabilities: { from: "none", subagents: true, goals: true } },
      expectedVersion: root.toolPolicyVersion,
    });
    expect(widened.status).toBe(422);
    expect(widened.json.error.details.code).toBe("agent_config_widening");
    const narrowed = await putAgent(target, bearer, grant, root.id, {
      agent: { capabilities: { from: "none", subagents: false } },
      expectedVersion: root.toolPolicyVersion,
    });
    expect(narrowed.status).toBe(200);
    expect(narrowed.json.agent.capabilities.subagents).toBe(false);
    expect(narrowed.json.firstPartyMcpTools).not.toContain("session_create");
  });

  test("previously mutable endpoints still work on a configured session", async () => {
    if (!available) return;
    const grant = await fixture();
    const target = app();
    const bearer = await humanBearer(grant);
    const created = await create(target, grant, {
      agent: { capabilities: { from: "all", goals: false } },
    });
    const sessionId = created.json.id as string;
    const title = await request(
      target,
      bearer,
      "PATCH",
      `/v1/workspaces/${grant.workspaceId}/sessions/${sessionId}`,
      { title: "Renamed" },
    );
    expect(title.status).toBe(200);
    // The tool-policy PUT keeps working and is clamped to the configuration:
    // goal tools of a goals-off session are not re-added.
    const policy = await request(
      target,
      bearer,
      "PUT",
      `/v1/workspaces/${grant.workspaceId}/sessions/${sessionId}/tool-policy`,
      {
        mode: "explicit",
        tools: [],
        firstPartyMcpTools: ["wait_for_input", "goal_set", "sessions_list"],
        expectedVersion: created.json.toolPolicyVersion,
      },
    );
    expect(policy.status).toBe(200);
    expect(sorted(policy.json.firstPartyMcpTools)).toEqual(["sessions_list", "wait_for_input"]);
    // And the agent PUT follows the bumped shared version.
    const agent = await putAgent(target, bearer, grant, sessionId, {
      agent: { renderer: "markdown" },
      expectedVersion: policy.json.toolPolicyVersion,
    });
    expect(agent.status).toBe(200);
    const stored = await getSession(client.db, grant.workspaceId, sessionId);
    expect(stored?.title).toBe("Renamed");
    expect(stored?.agent?.renderer).toBe("markdown");
  });
});

describe("MCP session_create agent narrowing (real PostgreSQL)", () => {
  test("children inherit the parent's configuration and may only narrow it", async () => {
    if (!available) return;
    const grant = await fixture();
    const parentTarget = app();
    const parent = await create(parentTarget, grant, {
      agent: { capabilities: { from: "none", subagents: true } },
    });
    const root = (await getSession(client.db, grant.workspaceId, parent.json.id))!;
    const attempt = await liveAttempt(grant, root.id);
    const server = buildOpenGeniMcpServer(
      routeDeps(),
      agentGrant(grant, attempt, root.firstPartyMcpTools),
    );
    const widened = await callMcpTool(server, "session_create", {
      initialMessage: "child work",
      agent: { capabilities: { from: "none", knowledge: true } },
    });
    expect(widened.isError).toBe(true);
    expect(widened.text).toContain("only narrow");

    const inherited = await callMcpTool(server, "session_create", {
      initialMessage: "child work",
    });
    expect(inherited.isError).not.toBe(true);
    const children = (await listChildren(grant, root.id)).filter(Boolean);
    expect(children.length).toBe(1);
    expect(children[0]!.agent).toMatchObject({ source: "inherited", from: "none" });
    expect(children[0]!.agent?.capabilities.knowledge).toBe(false);

    const narrowed = await callMcpTool(server, "session_create", {
      initialMessage: "leaf work",
      agent: { capabilities: { from: "none", subagents: false } },
    });
    expect(narrowed.isError).not.toBe(true);
    const leaf = (await listChildren(grant, root.id)).find(
      (child) => child.agent?.capabilities.subagents === false,
    );
    expect(leaf?.firstPartyMcpTools).not.toContain("session_create");
  });
});

// ---------------------------------------------------------------------------

async function rootSession(
  grant: Grant,
  agentConfig: Session["agent"],
  legacyFirstPartyMcpTools: FirstPartyMcpToolName[] = ["session_create"],
) {
  const firstPartyMcpTools: FirstPartyMcpToolName[] = agentConfig
    ? [...RUNTIME_TOOLS, "session_create", "sessions_list"].map(
        (tool) => tool as FirstPartyMcpToolName,
      )
    : legacyFirstPartyMcpTools;
  return await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "root",
    resources: [],
    tools: [],
    metadata: {},
    model: settings().openaiModel,
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    firstPartyMcpTools,
    ...(agentConfig ? { agentConfig } : {}),
    createdBy: { kind: "subject", subjectId: grant.subjectId, label: "Test owner" },
    createdByContext: {},
  });
}

async function liveAttempt(grant: Grant, sessionId: string) {
  const started = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: null,
  });
  if (!started.turn) throw new Error("test session did not create an initial turn");
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("test attempt was not claimed");
  return {
    sessionId,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
  };
}

type Attempt = Awaited<ReturnType<typeof liveAttempt>>;

async function agentBearer(
  grant: Grant,
  attempt: Attempt,
  firstPartyMcpTools: FirstPartyMcpToolName[],
): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: "worker:first-party-mcp",
    permissions: AGENT_PERMISSIONS,
    principalKind: "agent_attempt",
    sessionId: attempt.sessionId,
    turnId: attempt.turnId,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
    firstPartyMcpTools,
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

function agentGrant(grant: Grant, attempt: Attempt, firstPartyMcpTools: FirstPartyMcpToolName[]) {
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: "worker:first-party-mcp",
    permissions: AGENT_PERMISSIONS,
    principalKind: "agent_attempt" as const,
    metadata: {
      sessionId: attempt.sessionId,
      turnId: attempt.turnId,
      attemptId: attempt.attemptId,
      executionGeneration: attempt.executionGeneration,
      firstPartyMcpTools,
    },
  };
}

async function callMcpTool(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; text: string }> {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) throw new Error(`MCP tool not registered: ${name}`);
  const result = (await tool.handler(args, {})) as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
  };
  return { isError: result.isError, text: result.content?.[0]?.text ?? "" };
}

async function listChildren(grant: Grant, parentSessionId: string) {
  const rows = await shared!.admin<{ id: string }[]>`
    SELECT id FROM sessions WHERE parent_session_id = ${parentSessionId}
  `;
  const sessions = await Promise.all(
    rows.map((row) => getSession(client.db, grant.workspaceId, row.id)),
  );
  return sessions.filter((session): session is NonNullable<typeof session> => session !== null);
}
