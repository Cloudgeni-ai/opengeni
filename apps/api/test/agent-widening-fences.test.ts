import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  signDelegatedAccessToken,
  type AttemptToolCatalog,
  type FirstPartyMcpToolName,
  type Permission,
} from "@opengeni/contracts";
import { digestAttemptToolCatalog } from "@opengeni/codemode";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getScheduledTaskCreatorPolicy,
  getSession,
  initializeSessionStartAtomically,
  persistAttemptToolCatalog,
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
import { registerSessionRoutes } from "../src/routes/sessions";

const SECRET = "agent-widening-fence-test-secret";
const ENVIRONMENTS_ENCRYPTION_KEY = Buffer.alloc(32, 41).toString("base64");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const AGENT_PERMISSIONS: Permission[] = [
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "goals:manage",
  "scheduled_tasks:manage",
  "workspace:read",
];

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

setDefaultTimeout(60_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-agent-widening-fences");
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
type Attempt = {
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

function settings(overrides: Parameters<typeof testSettings>[0] = {}) {
  return testSettings({
    productAccessMode: "managed",
    delegationSecret: SECRET,
    environmentsEncryptionKey: ENVIRONMENTS_ENCRYPTION_KEY,
    sandboxBackend: "none",
    ...overrides,
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

function sessionRoutesApp(): Hono {
  const app = new Hono();
  registerSessionRoutes(app, routeDeps());
  return app;
}

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "agent-widening-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Agent widening fences",
    workspaceExternalSource: "agent-widening-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Agent widening fences",
    subjectId: `user:${suffix}`,
  });
  return access.workspaceGrants[0]!;
}

async function narrowedRootSession(
  grant: Grant,
  firstPartyMcpTools: FirstPartyMcpToolName[],
  firstPartyMcpPermissions: Permission[] | null = null,
) {
  return await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "narrowed root",
    resources: [],
    tools: [],
    metadata: {},
    // A child inherits its parent's model, which must be admissible.
    model: settings().openaiModel,
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    firstPartyMcpTools,
    firstPartyMcpPermissions,
    createdBy: { kind: "subject", subjectId: grant.subjectId, label: "Test owner" },
    createdByContext: {},
  });
}

/** Claim a live attempt on the session's initial turn the way the worker does. */
async function liveAttempt(grant: Grant, sessionId: string): Promise<Attempt> {
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

async function agentBearer(
  grant: Grant,
  attempt: Attempt,
  firstPartyMcpTools: FirstPartyMcpToolName[],
  permissions: Permission[] = AGENT_PERMISSIONS,
): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: "worker:first-party-mcp",
    permissions,
    principalKind: "agent_attempt",
    sessionId: attempt.sessionId,
    turnId: attempt.turnId,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
    firstPartyMcpTools,
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

async function humanBearer(grant: Grant): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: ["sessions:read", "sessions:control", "sessions:create"],
    principalKind: "human_session",
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

describe("child first-party tool selection may only narrow (real PostgreSQL)", () => {
  test("a narrowed session cannot spawn a child that sees more tools than it does", async () => {
    if (!available) return;
    const grant = await fixture();
    const root = await narrowedRootSession(grant, ["set_session_title", "session_create"]);
    const attempt = await liveAttempt(grant, root.id);
    const app = sessionRoutesApp();
    const create = (firstPartyMcpTools: FirstPartyMcpToolName[] | undefined) =>
      app.request(`/v1/workspaces/${grant.workspaceId}/sessions`, {
        method: "POST",
        headers: {
          authorization: agentBearerValue,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          initialMessage: "child work",
          resources: [],
          ...(firstPartyMcpTools === undefined ? {} : { firstPartyMcpTools }),
        }),
      });
    const agentBearerValue = await agentBearer(grant, attempt, [
      "set_session_title",
      "session_create",
    ]);

    // The hole: the explicit child list was returned verbatim, so this
    // narrowed parent could hand its child goal_set and sessions_list.
    const widened = await create(["set_session_title", "goal_set", "sessions_list"]);
    expect(widened.status).toBe(403);
    expect(await widened.text()).toContain(
      "child first-party MCP tools may only narrow the parent session selection: goal_set",
    );

    const narrowed = await create(["set_session_title"]);
    expect(narrowed.status).toBe(202);
    const narrowedChild = (await narrowed.json()) as {
      id: string;
      parentSessionId: string | null;
      firstPartyMcpTools: FirstPartyMcpToolName[];
    };
    expect(narrowedChild.parentSessionId).toBe(root.id);
    expect(narrowedChild.firstPartyMcpTools).toEqual(["set_session_title"]);

    const inherited = await create(undefined);
    expect(inherited.status).toBe(202);
    expect(
      ((await inherited.json()) as { firstPartyMcpTools: FirstPartyMcpToolName[] })
        .firstPartyMcpTools,
    ).toEqual(["set_session_title", "session_create"]);
  });

  test("the session_create MCP tool applies the same fence and says so", async () => {
    if (!available) return;
    const grant = await fixture();
    const root = await narrowedRootSession(grant, ["set_session_title", "session_create"]);
    const attempt = await liveAttempt(grant, root.id);
    const server = buildOpenGeniMcpServer(
      routeDeps(),
      agentGrant(grant, attempt, ["set_session_title", "session_create"]),
    );
    const description = (
      server as unknown as { _registeredTools: Record<string, { description: string }> }
    )._registeredTools["session_create"]!.description;
    expect(description).toContain("narrow");
    const result = await callMcpTool(server, "session_create", {
      initialMessage: "child work",
      firstPartyMcpTools: ["set_session_title", "sessions_list"],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      "child first-party MCP tools may only narrow the parent session selection: sessions_list",
    );
  });
});

describe("parentless tool policy: agents narrow, humans may widen (real PostgreSQL)", () => {
  test("an agent attempt cannot widen its own top-level session through PUT /tool-policy", async () => {
    if (!available) return;
    const grant = await fixture();
    const root = await narrowedRootSession(grant, ["set_session_title"]);
    const attempt = await liveAttempt(grant, root.id);
    const app = sessionRoutesApp();
    const path = `/v1/workspaces/${grant.workspaceId}/sessions/${root.id}/tool-policy`;
    const agent = await agentBearer(grant, attempt, ["set_session_title"]);
    const put = (authorization: string, body: Record<string, unknown>) =>
      app.request(path, {
        method: "PUT",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // The hole: the parentless branch assigned the request unchecked, so a
    // title-only session could grant itself goal tools and session discovery.
    const widened = await put(agent, {
      mode: "explicit",
      tools: [],
      firstPartyMcpTools: ["set_session_title", "goal_set"],
      expectedVersion: 1,
    });
    expect(widened.status).toBe(403);
    expect(await widened.text()).toContain(
      "an agent may only narrow its session OpenGeni tools: goal_set",
    );

    // Adopting workspace defaults is a widen whenever it adds anything.
    const defaults = await put(agent, { mode: "workspace_default", expectedVersion: 1 });
    expect(defaults.status).toBe(403);
    expect(await defaults.text()).toContain("an agent may only narrow its session OpenGeni tools");

    // Narrowing (here: to nothing) still works for the agent.
    const narrowed = await put(agent, {
      mode: "explicit",
      tools: [],
      firstPartyMcpTools: [],
      expectedVersion: 1,
    });
    expect(narrowed.status).toBe(200);
    expect(await narrowed.json()).toMatchObject({
      id: root.id,
      firstPartyMcpTools: [],
      toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
      toolPolicyVersion: 2,
    });

    // A human keeps today's ability to widen a top-level session.
    const human = await put(await humanBearer(grant), {
      mode: "explicit",
      tools: [],
      firstPartyMcpTools: ["set_session_title", "goal_set"],
      expectedVersion: 2,
    });
    expect(human.status).toBe(200);
    expect(await human.json()).toMatchObject({
      firstPartyMcpTools: ["set_session_title", "goal_set"],
      toolPolicyVersion: 3,
    });
    expect((await getSession(client.db, grant.workspaceId, root.id))?.firstPartyMcpTools).toEqual([
      "set_session_title",
      "goal_set",
    ]);
  });
});

describe("agent-created scheduled tasks freeze the creator boundary (real PostgreSQL)", () => {
  test("scheduled_tasks_create stores the calling session's effective tools and permissions", async () => {
    if (!available) return;
    const grant = await fixture();
    const root = await narrowedRootSession(
      grant,
      ["set_session_title", "scheduled_tasks_create"],
      ["sessions:read", "sessions:control", "scheduled_tasks:manage", "workspace:read"],
    );
    const attempt = await liveAttempt(grant, root.id);
    const server = buildOpenGeniMcpServer(
      routeDeps(),
      agentGrant(grant, attempt, ["set_session_title", "scheduled_tasks_create"]),
    );
    const result = await callMcpTool(server, "scheduled_tasks_create", {
      name: "Nightly narrowed run",
      schedule: { type: "manual" },
      runMode: "new_session_per_run",
      agentConfig: { prompt: "run narrowed", resources: [], tools: [], metadata: {} },
    });
    expect(result.isError).toBeFalsy();
    const receipt = JSON.parse(result.text) as { resource: { type: string; id: string } };
    expect(receipt.resource.type).toBe("scheduled_task");
    const taskId = receipt.resource.id;
    expect(await getScheduledTaskCreatorPolicy(client.db, grant.workspaceId, taskId)).toEqual({
      firstPartyMcpTools: ["set_session_title", "scheduled_tasks_create"],
      firstPartyMcpPermissions: [
        "sessions:read",
        "sessions:control",
        "scheduled_tasks:manage",
        "workspace:read",
      ],
      sessionPolicy: expect.objectContaining({}),
    });
  });

  test("a human create leaves the creator boundary empty", async () => {
    if (!available) return;
    const grant = await fixture();
    const app = new Hono();
    const deps = routeDeps();
    const { registerScheduledTaskRoutes } = await import("../src/routes/scheduled-tasks");
    registerScheduledTaskRoutes(app, deps);
    const response = await app.request(`/v1/workspaces/${grant.workspaceId}/scheduled-tasks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await signDelegatedAccessToken(SECRET, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          subjectId: grant.subjectId,
          permissions: ["scheduled_tasks:manage", "sessions:read"],
          principalKind: "human_session",
          exp: Math.floor(Date.now() / 1000) + 3_600,
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Human task",
        schedule: { type: "manual" },
        runMode: "new_session_per_run",
        agentConfig: { prompt: "run", resources: [], tools: [], metadata: {} },
      }),
    });
    expect(response.status).toBeLessThan(300);
    const task = (await response.json()) as { id: string };
    expect(await getScheduledTaskCreatorPolicy(client.db, grant.workspaceId, task.id)).toEqual({
      firstPartyMcpTools: null,
      firstPartyMcpPermissions: null,
      sessionPolicy: null,
    });
  });
});

describe("Codemode SDK proxy carries only what the selection can exercise (real PostgreSQL)", () => {
  async function seedRunningAttempt(
    grant: Grant,
    firstPartyMcpTools: FirstPartyMcpToolName[],
  ): Promise<Attempt> {
    const session = await narrowedRootSession(grant, firstPartyMcpTools);
    const executionGeneration = 2;
    const [turn] = await shared!.admin<{ id: string }[]>`
      INSERT INTO session_turns (
        account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, position, prompt, model, reasoning_effort, sandbox_backend,
        execution_generation, initiator_kind, initiator_subject_id, initiator_context
      ) VALUES (
        ${grant.accountId}, ${grant.workspaceId}, ${session.id}, gen_random_uuid(),
        ${`codemode-wf-${crypto.randomUUID()}`}, 'running', 0, 'Proxy through the SDK',
        'test-model', 'medium', 'none', ${executionGeneration}, 'subject',
        ${grant.subjectId}, '{"accepted":true}'::jsonb
      ) RETURNING id`;
    const attemptId = crypto.randomUUID();
    await shared!.admin.begin(async (tx) => {
      await tx`UPDATE sessions SET active_turn_id = ${turn!.id} WHERE id = ${session.id}`;
      await tx`UPDATE session_turns SET active_attempt_id = ${attemptId} WHERE id = ${turn!.id}`;
      await tx`
        INSERT INTO session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id, execution_generation,
          state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
          verified_control_revision, mcp_approval_policies
        ) VALUES (
          ${attemptId}, ${grant.accountId}, ${grant.workspaceId}, ${session.id},
          ${turn!.id}, ${executionGeneration}, 'running', 'codemode-wf', ${`run-${attemptId}`},
          ${`activity-${attemptId}`}, 0, '{}'::jsonb
        )`;
    });
    const attempt = { sessionId: session.id, turnId: turn!.id, attemptId, executionGeneration };
    const unsigned: Omit<AttemptToolCatalog, "digest"> = {
      version: 1,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      ...attempt,
      generation: 1,
      createdAt: new Date().toISOString(),
      entries: [],
    };
    await persistAttemptToolCatalog(client.db, {
      ...unsigned,
      digest: digestAttemptToolCatalog(unsigned),
    });
    return attempt;
  }

  async function codemodeBearer(grant: Grant, attempt: Attempt): Promise<string> {
    return `Bearer ${await signDelegatedAccessToken(SECRET, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: `sandbox:${attempt.attemptId}`,
      subjectLabel: "sandbox Codemode",
      permissions: ["codemode:call"],
      sessionId: attempt.sessionId,
      turnId: attempt.turnId,
      attemptId: attempt.attemptId,
      executionGeneration: attempt.executionGeneration,
      principalKind: "agent_attempt",
      exp: Math.floor(Date.now() / 1000) + 3_600,
    })}`;
  }

  function fullApp(): Hono {
    return createApp({
      settings: settings(),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as SessionWorkflowClient,
    });
  }

  test("a title-only session can no longer list or create sessions through the proxy", async () => {
    if (!available) return;
    const grant = await fixture();
    const app = fullApp();
    const attempt = await seedRunningAttempt(grant, ["set_session_title"]);
    const authorization = await codemodeBearer(grant, attempt);
    const proxied = (method: string, suffix: string, body?: unknown) =>
      app.request(`/v1/workspaces/${grant.workspaceId}/codemode/sdk${suffix}`, {
        method,
        headers: {
          authorization,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    // The hole: the proxy token carried the whole session permission set, so
    // a session whose model could only set its title still listed and created
    // sessions with the SDK from inside the sandbox.
    const list = await proxied("GET", "/v1/workspaces/site-host/sessions");
    expect(list.status).toBe(403);
    const create = await proxied("POST", "/v1/workspaces/site-host/sessions", {
      initialMessage: "escape",
      resources: [],
    });
    expect(create.status).toBe(403);
    const read = await proxied("GET", `/v1/workspaces/site-host/sessions/${attempt.sessionId}`);
    expect(read.status).toBe(403);

    // The read-only context surface (workspace:read) still works.
    const workspace = await proxied("GET", "/v1/workspaces/site-host");
    expect(workspace.status).toBe(200);
  });

  test("a session that selects sessions_list keeps list access and nothing more", async () => {
    if (!available) return;
    const grant = await fixture();
    const app = fullApp();
    const attempt = await seedRunningAttempt(grant, ["sessions_list"]);
    const authorization = await codemodeBearer(grant, attempt);
    const list = await app.request(
      `/v1/workspaces/${grant.workspaceId}/codemode/sdk/v1/workspaces/site-host/sessions`,
      { headers: { authorization } },
    );
    expect(list.status).toBe(200);
    const create = await app.request(
      `/v1/workspaces/${grant.workspaceId}/codemode/sdk/v1/workspaces/site-host/sessions`,
      {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ initialMessage: "escape", resources: [] }),
      },
    );
    expect(create.status).toBe(403);
  });

  test("configuration and control routes retain normal permission checks behind the proxy", async () => {
    if (!available) return;
    const grant = await fixture();
    const app = fullApp();
    const attempt = await seedRunningAttempt(grant, ["sessions_list"]);
    const authorization = await codemodeBearer(grant, attempt);
    for (const [method, suffix] of [
      ["PUT", `/v1/workspaces/site-host/sessions/${attempt.sessionId}/tool-policy`],
      ["POST", `/v1/workspaces/site-host/sessions/${attempt.sessionId}/steer`],
      ["POST", `/v1/workspaces/site-host/sessions/${attempt.sessionId}/control`],
      ["PATCH", `/v1/workspaces/site-host/sessions/${attempt.sessionId}/goal`],
      ["GET", "/v1/workspaces/site-host/api-keys"],
      ["DELETE", "/v1/workspaces/site-host"],
    ] as const) {
      const response = await app.request(
        `/v1/workspaces/${grant.workspaceId}/codemode/sdk${suffix}`,
        {
          method,
          headers: { authorization, "content-type": "application/json" },
          ...(method === "GET" ? {} : { body: "{}" }),
        },
      );
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("Unsupported Site session API path");
    }
    const session = await getSession(client.db, grant.workspaceId, attempt.sessionId);
    expect(session?.toolPolicyVersion ?? 1).toBe(1);
  });
});
