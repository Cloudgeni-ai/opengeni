import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccessGrant, Permission } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getSession,
  createChannel,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let accountId = "";
let workspaceId = "";

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_projects_mcp");
  if (!shared) {
    available = false;
    console.warn("[projects-mcp] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "opengeni:test",
    accountExternalId: `projects-mcp-${crypto.randomUUID()}`,
    accountName: "Projects MCP",
    workspaceExternalSource: "opengeni:test",
    workspaceExternalId: `projects-mcp-${crypto.randomUUID()}`,
    workspaceName: "Projects MCP",
    subjectId: "user:mcp",
  });
  accountId = access.defaultAccountId!;
  workspaceId = access.defaultWorkspaceId!;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe("project MCP tools", () => {
  test("session authorization denial happens before filing", async () => {
    if (!available) return;
    const session = await createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: "Do not move",
      resources: [],
      tools: [],
      metadata: {},
      model: "gpt-test",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const project = await createChannel(client.db, {
      accountId,
      workspaceId,
      name: "Denied destination",
    });
    let checked = false;
    const guardedDeps = deps(new FakeWorkflowClient());
    guardedDeps.sessionAuthorization = {
      authorizeSession: async () => {
        checked = true;
        return { allowed: false, reason: "forbidden" };
      },
    } as NonNullable<ApiRouteDeps["sessionAuthorization"]>;
    const server = buildOpenGeniMcpServer(guardedDeps, {
      ...grant(["sessions:control"]),
      principalKind: "human_session",
    });
    await expect(
      callMcpTool(server, "session_set_project", { sessionId: session.id, projectId: project.id }),
    ).rejects.toThrow();
    expect(checked).toBe(true);
    expect((await getSession(client.db, workspaceId, session.id))!.channelId).toBeNull();
    const cleanup = buildOpenGeniMcpServer(
      deps(new FakeWorkflowClient()),
      grant(["sessions:create"]),
    );
    await callMcpTool(cleanup, "project_delete", { projectId: project.id });
  });
  test("shared project CRUD, ordering and workspace isolation", async () => {
    if (!available) return;
    const server = buildOpenGeniMcpServer(
      deps(new FakeWorkflowClient()),
      grant(["sessions:read", "sessions:create", "sessions:control"]),
    );
    const a = await callMcpTool<{ project: { id: string } }>(server, "project_create", {
      name: "Alpha",
    });
    const b = await callMcpTool<{ project: { id: string } }>(server, "project_create", {
      name: "Beta",
      description: "Related work",
    });
    const ids = [b.project.id, a.project.id];
    expect(
      (
        await callMcpTool<{ projects: { id: string }[] }>(server, "project_reorder", {
          projectIds: ids,
        })
      ).projects.map((p) => p.id),
    ).toEqual(ids);
    const updated = await callMcpTool<{
      project: { name: string; description: null; pinned: boolean };
    }>(server, "project_update", {
      projectId: a.project.id,
      name: "Renamed",
      description: null,
      pinned: true,
    });
    expect(updated.project).toMatchObject({ name: "Renamed", description: null, pinned: true });
    expect(
      (await callMcpTool<{ projects: { id: string }[] }>(server, "project_list", {})).projects[0]!
        .id,
    ).toBe(a.project.id);
    await expect(callMcpTool(server, "project_create", { name: "renamed" })).rejects.toThrow();
    await expect(
      callMcpTool(server, "project_reorder", { projectIds: [a.project.id] }),
    ).rejects.toThrow();
    await expect(
      callMcpTool(server, "project_reorder", { projectIds: [a.project.id, a.project.id] }),
    ).rejects.toThrow();
    const foreign = await bootstrapWorkspace(client.db, {
      accountExternalSource: "opengeni:test",
      accountExternalId: crypto.randomUUID(),
      accountName: "Other",
      workspaceExternalSource: "opengeni:test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Other",
      subjectId: "user:mcp",
    });
    const foreignProject = await createChannel(client.db, {
      accountId: foreign.defaultAccountId!,
      workspaceId: foreign.defaultWorkspaceId!,
      name: "Foreign",
    });
    for (const tool of ["project_get", "project_update", "project_delete"]) {
      await expect(
        callMcpTool(server, tool, { projectId: foreignProject.id, name: "Forbidden" }),
      ).rejects.toThrow();
    }
    await callMcpTool(server, "project_delete", { projectId: a.project.id });
    await callMcpTool(server, "project_delete", { projectId: b.project.id });
  });

  test("filing, paginated discovery and deletion preserve sessions", async () => {
    if (!available) return;
    const server = buildOpenGeniMcpServer(
      deps(new FakeWorkflowClient()),
      grant(["sessions:read", "sessions:create", "sessions:control"]),
    );
    const { project } = await callMcpTool<{ project: { id: string } }>(server, "project_create", {
      name: "Filed work",
    });
    const sessions = [];
    for (let i = 0; i < 2; i++)
      sessions.push(
        await createSession(client.db, {
          accountId,
          workspaceId,
          initialMessage: "Organize work",
          resources: [],
          tools: [],
          metadata: {},
          model: "gpt-test",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
        }),
      );
    for (const session of sessions)
      await callMcpTool(server, "session_set_project", {
        sessionId: session.id,
        projectId: project.id,
      });
    const page = await callMcpTool<{
      sessions: { id: string; projectId: string }[];
      nextCursor: string;
      total: number;
    }>(server, "sessions_list", { projectId: project.id, limit: 1 });
    expect(page.total).toBe(2);
    expect(page.sessions).toHaveLength(1);
    expect(page.sessions[0]!.projectId).toBe(project.id);
    const updatedOrder = await callMcpTool<{
      sessions: { id: string; projectId: string }[];
      total: number;
    }>(server, "sessions_list", { projectId: project.id, orderBy: "updatedAt" });
    expect(updatedOrder.total).toBe(2);
    expect(updatedOrder.sessions.every((s) => s.projectId === project.id)).toBe(true);
    const unfiled = await callMcpTool<{ sessions: { id: string }[] }>(server, "sessions_list", {
      projectId: null,
    });
    expect(unfiled.sessions.some((s) => sessions.some((filed) => filed.id === s.id))).toBe(false);
    const next = await callMcpTool<{ sessions: { id: string }[] }>(server, "sessions_list", {
      projectId: project.id,
      limit: 1,
      cursor: page.nextCursor,
    });
    expect(next.sessions).toHaveLength(1);
    expect(next.sessions[0]!.id).not.toBe(page.sessions[0]!.id);
    await callMcpTool(server, "session_set_project", {
      sessionId: sessions[0]!.id,
      projectId: null,
    });
    expect((await getSession(client.db, workspaceId, sessions[0]!.id))!.channelId).toBeNull();
    await callMcpTool(server, "project_delete", { projectId: project.id });
    for (const session of sessions) {
      const retained = await getSession(client.db, workspaceId, session.id);
      expect(retained).not.toBeNull();
      expect(retained!.channelId).toBeNull();
      expect(retained!.status).toBe(session.status);
    }
  });
});

function deps(workflowClient: SessionWorkflowClient): ApiRouteDeps {
  return {
    settings: testSettings({}),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient,
    objectStorage: null,
    githubStateSecret: "test-state-secret",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services not used");
    },
    resumeBoxById: async () => {
      throw new Error("resumeBoxById not used");
    },
  } as never;
}

function grant(permissions: Permission[], metadata: Record<string, unknown> = {}): AccessGrant {
  return {
    accountId,
    workspaceId,
    subjectId: "user:mcp",
    permissions,
    metadata,
  };
}

async function callMcpTool<T = unknown>(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        {
          handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
        }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) {
    throw new Error(`MCP tool not registered: ${name}`);
  }
  const result = await tool.handler(args, {});
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  if (!text) {
    throw new Error(`MCP tool returned no text: ${name}`);
  }
  return JSON.parse(text) as T;
}

class FakeWorkflowClient implements SessionWorkflowClient {
  rigVerifications: unknown[] = [];
  async signalUserMessage(): Promise<void> {}
  async wakeSessionWorkflow(): Promise<void> {}
  async requestSessionWorkflowWakeDispatch(): Promise<void> {}
  async signalApprovalDecision(): Promise<void> {}
  async signalSessionControl(): Promise<void> {}
  async syncScheduledTask(): Promise<void> {}
  async deleteScheduledTaskSchedule(): Promise<void> {}
  async triggerScheduledTask(): Promise<void> {}
  async startRigVerification(input: unknown): Promise<void> {
    this.rigVerifications.push(input);
  }
}
