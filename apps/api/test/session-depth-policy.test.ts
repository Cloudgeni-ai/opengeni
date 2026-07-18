import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccessGrant, Permission } from "@opengeni/contracts";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  createDb,
  dbSql,
  getScheduledTask,
  getSession,
  withWorkspaceRls,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import postgres from "postgres";
import { createApp } from "../src/app";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

const DELEGATION_SECRET = "nested-depth-api-test-secret";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;

type Workspace = { accountId: string; workspaceId: string };

async function freshWorkspace(name: string): Promise<Workspace> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${name}) returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, ${name}) returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

class WorkflowStub implements SessionWorkflowClient {
  wakeups: unknown[] = [];
  synced: unknown[] = [];

  async signalUserMessage(): Promise<void> {}
  async wakeSessionWorkflow(input: unknown): Promise<void> {
    this.wakeups.push(input);
  }
  async requestSessionWorkflowWakeDispatch(): Promise<void> {}
  async signalApprovalDecision(): Promise<void> {}
  async signalSessionControl(): Promise<void> {}
  async syncScheduledTask(input: unknown): Promise<void> {
    this.synced.push(input);
  }
  async deleteScheduledTaskSchedule(): Promise<void> {}
  async triggerScheduledTask(): Promise<void> {}
}

function dependencies(
  settings: ReturnType<typeof testSettings>,
  workflowClient: WorkflowStub,
): ApiRouteDeps {
  return {
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient,
    objectStorage: null,
    githubStateSecret: "nested-depth-test-state",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services are not used by nested-depth tests");
    },
    resumeBoxById: async () => {
      throw new Error("sandbox resume is not used with backend=none");
    },
  } as unknown as ApiRouteDeps;
}

async function bearer(
  workspace: Workspace,
  subjectId: string,
  permissions: Permission[],
  sessionId?: string,
): Promise<string> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId,
    subjectLabel: subjectId,
    permissions,
    ...(sessionId ? { sessionId } : {}),
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  return `Bearer ${token}`;
}

function path(workspaceId: string, suffix: string): string {
  return `/v1/workspaces/${workspaceId}${suffix}`;
}

type DepthDenialEnvelope = {
  error: {
    code: "nested_agent_depth_exceeded" | "nested_agent_depth_override_forbidden";
    details: {
      denial: {
        id: string;
        parentSessionId: string | null;
        rootSessionId: string | null;
        currentDepth: number;
        attemptedDepth: number;
        effectiveMaxNestedAgentDepth: number;
        requestedMaxNestedAgentDepthOverride: number | null;
        policySource: "session" | "workspace" | "deployment" | "default";
        idempotencyKey: string | null;
      };
    };
  };
};

async function deniedArtifactCount(workspaceId: string, denialId: string): Promise<number> {
  return await withWorkspaceRls(client.db, workspaceId, async (db) => {
    const rows = await db.execute(dbSql<{ total: number }>`
      select (
        (select count(*) from sessions where workspace_id = ${workspaceId} and id = ${denialId}) +
        (select count(*) from session_mcp_servers where workspace_id = ${workspaceId} and session_id = ${denialId}) +
        (select count(*) from session_goals where workspace_id = ${workspaceId} and session_id = ${denialId}) +
        (select count(*) from session_events where workspace_id = ${workspaceId} and session_id = ${denialId}) +
        (select count(*) from session_turns where workspace_id = ${workspaceId} and session_id = ${denialId}) +
        (select count(*) from session_turn_attempts where workspace_id = ${workspaceId} and session_id = ${denialId}) +
        (select count(*) from agent_run_states where workspace_id = ${workspaceId} and session_id = ${denialId}) +
        (select count(*) from session_system_updates where workspace_id = ${workspaceId} and session_id = ${denialId}) +
        (select count(*) from session_workflow_wake_outbox where workspace_id = ${workspaceId} and session_id = ${denialId}) +
        (select count(*) from sandbox_session_envelopes where workspace_id = ${workspaceId} and session_id = ${denialId}) +
        (select count(*) from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${denialId}) +
        (select count(*) from usage_events where workspace_id = ${workspaceId} and source_resource_id = ${denialId}) +
        (select count(*) from credit_ledger_entries where workspace_id = ${workspaceId} and source_id = ${denialId}) +
        (select count(*) from audit_events where workspace_id = ${workspaceId} and target_id = ${denialId})
      )::int as total
    `);
    return Number(rows[0]?.total ?? 0);
  });
}

async function usageCount(workspaceId: string): Promise<number> {
  const [row] = await admin<{ count: number }[]>`
    select count(*)::int as count from usage_events where workspace_id = ${workspaceId}`;
  return row?.count ?? 0;
}

function grant(workspace: Workspace, subjectId: string, sessionId?: string): AccessGrant {
  return {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId,
    permissions: ["workspace:read", "sessions:create", "sessions:read"],
    ...(sessionId ? { metadata: { delegated: true, sessionId } } : {}),
  };
}

async function callTool(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<{ body: unknown; isError: boolean }> {
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
    content?: Array<{ text?: string }>;
    isError?: boolean;
  };
  const text = result.content?.[0]?.text;
  if (!text) throw new Error(`MCP tool returned no text: ${name}`);
  return { body: JSON.parse(text) as unknown, isError: result.isError === true };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-session-depth-policy");
  if (!shared) {
    available = false;
    console.warn("[api-session-depth-policy] PostgreSQL unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

describe("nested-agent depth at HTTP/MCP creation boundaries (real PostgreSQL)", () => {
  test("HTTP returns committed typed denials before start/usage side effects", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("api depth policy");
    const workflow = new WorkflowStub();
    const settings = testSettings({
      databaseUrl: shared!.appUrl,
      productAccessMode: "managed",
      delegationSecret: DELEGATION_SECRET,
      sandboxBackend: "none",
      maxNestedAgentDepth: 0,
    });
    const app = createApp(dependencies(settings, workflow));
    const rootAuth = await bearer(workspace, "depth-root", [
      "workspace:read",
      "sessions:create",
      "sessions:read",
    ]);
    const rootResponse = await app.request(path(workspace.workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: rootAuth },
      body: JSON.stringify({ initialMessage: "root", model: "scripted-model" }),
    });
    expect(rootResponse.status).toBe(202);
    const root = (await rootResponse.json()) as {
      id: string;
      nestedAgentDepth: number;
      effectiveMaxNestedAgentDepth: number;
      nestedAgentDepthPolicySource: string;
    };
    expect(root).toMatchObject({
      nestedAgentDepth: 0,
      effectiveMaxNestedAgentDepth: 0,
      nestedAgentDepthPolicySource: "deployment",
    });

    const childAuth = await bearer(
      workspace,
      "depth-child",
      ["workspace:read", "sessions:create", "sessions:read"],
      root.id,
    );
    const key = `api-depth-denial-${crypto.randomUUID()}`;
    const usageBefore = await usageCount(workspace.workspaceId);
    const wakesBefore = workflow.wakeups.length;
    const denied = await app.request(path(workspace.workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: childAuth },
      body: JSON.stringify({
        initialMessage: "denied child",
        model: "scripted-model",
        idempotencyKey: key,
      }),
    });
    expect(denied.status).toBe(409);
    const denial = (await denied.json()) as DepthDenialEnvelope;
    expect(denial.error).toMatchObject({
      code: "nested_agent_depth_exceeded",
      details: {
        denial: {
          parentSessionId: root.id,
          rootSessionId: root.id,
          currentDepth: 0,
          attemptedDepth: 1,
          effectiveMaxNestedAgentDepth: 0,
          policySource: "deployment",
          idempotencyKey: key,
        },
      },
    });

    const retry = await app.request(path(workspace.workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: childAuth },
      body: JSON.stringify({
        initialMessage: "mutated retry",
        model: "scripted-model",
        idempotencyKey: key,
        maxNestedAgentDepth: 1,
      }),
    });
    expect(retry.status).toBe(409);
    const replay = (await retry.json()) as DepthDenialEnvelope;
    expect(replay.error.details.denial.id).toBe(denial.error.details.denial.id);
    expect(await deniedArtifactCount(workspace.workspaceId, denial.error.details.denial.id)).toBe(
      0,
    );
    expect(await usageCount(workspace.workspaceId)).toBe(usageBefore);
    expect(workflow.wakeups).toHaveLength(wakesBefore);

    const forbidden = await app.request(path(workspace.workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: childAuth },
      body: JSON.stringify({
        initialMessage: "forbidden increase",
        model: "scripted-model",
        maxNestedAgentDepth: 1,
      }),
    });
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as DepthDenialEnvelope).error.code).toBe(
      "nested_agent_depth_override_forbidden",
    );

    const adminAuth = await bearer(workspace, "depth-admin", ["workspace:admin"], root.id);
    const authorized = await app.request(path(workspace.workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: adminAuth },
      body: JSON.stringify({
        initialMessage: "authorized increase",
        model: "scripted-model",
        maxNestedAgentDepth: 1,
      }),
    });
    expect(authorized.status).toBe(202);
    expect(await authorized.json()).toMatchObject({
      parentSessionId: root.id,
      nestedAgentDepth: 1,
      maxNestedAgentDepthOverride: 1,
      effectiveMaxNestedAgentDepth: 1,
      nestedAgentDepthPolicySource: "session",
    });
  }, 60_000);

  test("MCP permits depth three and returns one model-readable depth-four outcome", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("mcp depth policy");
    const workflow = new WorkflowStub();
    const settings = testSettings({
      databaseUrl: shared!.appUrl,
      sandboxBackend: "none",
    });
    const deps = dependencies(settings, workflow);
    const spawn = async (parentSessionId: string | undefined, label: string) => {
      const server = buildOpenGeniMcpServer(
        deps,
        grant(workspace, `mcp:${label}`, parentSessionId),
      );
      const result = await callTool(server, "session_create", {
        initialMessage: label,
        model: "scripted-model",
        sandbox: "new",
      });
      expect(result.isError).toBe(false);
      return result.body as {
        id: string;
        rootSessionId: string;
        nestedAgentDepth: number;
        effectiveMaxNestedAgentDepth: number;
      };
    };
    const root = await spawn(undefined, "root");
    const depth1 = await spawn(root.id, "depth1");
    const depth2 = await spawn(depth1.id, "depth2");
    const depth3 = await spawn(depth2.id, "depth3");
    expect([root, depth1, depth2, depth3].map((session) => session.nestedAgentDepth)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(depth3).toMatchObject({ rootSessionId: root.id, effectiveMaxNestedAgentDepth: 3 });

    const server = buildOpenGeniMcpServer(deps, grant(workspace, "mcp:depth4", depth3.id));
    const key = `mcp-depth-denial-${crypto.randomUUID()}`;
    const usageBefore = await usageCount(workspace.workspaceId);
    const wakesBefore = workflow.wakeups.length;
    const first = await callTool(server, "session_create", {
      initialMessage: "depth4 denied",
      model: "scripted-model",
      sandbox: "new",
      idempotencyKey: key,
    });
    const retry = await callTool(server, "session_create", {
      initialMessage: "depth4 retry",
      model: "scripted-model",
      sandbox: "new",
      idempotencyKey: key,
    });
    expect(first.isError).toBe(true);
    expect(retry.isError).toBe(true);
    const denial = first.body as DepthDenialEnvelope;
    const replay = retry.body as DepthDenialEnvelope;
    expect(denial.error).toMatchObject({
      code: "nested_agent_depth_exceeded",
      details: {
        denial: {
          parentSessionId: depth3.id,
          rootSessionId: root.id,
          currentDepth: 3,
          attemptedDepth: 4,
          effectiveMaxNestedAgentDepth: 3,
          policySource: "default",
          idempotencyKey: key,
        },
      },
    });
    expect(replay.error.details.denial.id).toBe(denial.error.details.denial.id);
    expect(await deniedArtifactCount(workspace.workspaceId, denial.error.details.denial.id)).toBe(
      0,
    );
    expect(await usageCount(workspace.workspaceId)).toBe(usageBefore);
    expect(workflow.wakeups).toHaveLength(wakesBefore);
    expect(await getSession(client.db, workspace.workspaceId, depth3.id)).not.toBeNull();
  }, 60_000);

  test("scheduled-task agent policy requires admin only for increases", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("scheduled agent depth policy");
    const workflow = new WorkflowStub();
    const app = createApp(
      dependencies(
        testSettings({
          databaseUrl: shared!.appUrl,
          productAccessMode: "managed",
          delegationSecret: DELEGATION_SECRET,
          sandboxBackend: "none",
          maxNestedAgentDepth: 1,
        }),
        workflow,
      ),
    );
    const managerAuth = await bearer(workspace, "schedule-manager", [
      "workspace:read",
      "scheduled_tasks:manage",
    ]);
    const body = (maxNestedAgentDepth: number) => ({
      name: `depth ${maxNestedAgentDepth}`,
      schedule: { type: "once", runAt: "2035-01-01T00:00:00.000Z", timeZone: "UTC" },
      agentConfig: { prompt: "scheduled depth policy", maxNestedAgentDepth },
    });
    const forbidden = await app.request(path(workspace.workspaceId, "/scheduled-tasks"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: managerAuth },
      body: JSON.stringify(body(2)),
    });
    expect(forbidden.status).toBe(403);
    const [countAfterForbidden] = await admin<{ count: number }[]>`
      select count(*)::int as count from scheduled_tasks where workspace_id = ${workspace.workspaceId}`;
    expect(countAfterForbidden?.count).toBe(0);

    const adminAuth = await bearer(workspace, "schedule-admin", ["workspace:admin"]);
    const createdResponse = await app.request(path(workspace.workspaceId, "/scheduled-tasks"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: adminAuth },
      body: JSON.stringify(body(5)),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      id: string;
      agentConfig: { maxNestedAgentDepth?: number };
    };
    expect(created.agentConfig.maxNestedAgentDepth).toBe(5);

    const lowered = await app.request(
      path(workspace.workspaceId, `/scheduled-tasks/${created.id}`),
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: managerAuth },
        body: JSON.stringify({
          agentConfig: { prompt: "lowered depth policy", maxNestedAgentDepth: 1 },
        }),
      },
    );
    expect(lowered.status).toBe(200);
    expect(await lowered.json()).toMatchObject({ agentConfig: { maxNestedAgentDepth: 1 } });

    const forbiddenUpdate = await app.request(
      path(workspace.workspaceId, `/scheduled-tasks/${created.id}`),
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: managerAuth },
        body: JSON.stringify({
          agentConfig: { prompt: "forbidden increase", maxNestedAgentDepth: 2 },
        }),
      },
    );
    expect(forbiddenUpdate.status).toBe(403);
    expect(
      (await getScheduledTask(client.db, workspace.workspaceId, created.id))?.agentConfig,
    ).toMatchObject({ maxNestedAgentDepth: 1 });
  }, 60_000);
});
