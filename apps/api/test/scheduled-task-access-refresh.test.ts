import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Settings } from "@opengeni/config";
import type { AccessGrant, Permission, ScheduledTask } from "@opengeni/contracts";
import {
  refreshScheduledTaskAccess,
  withScheduledTaskPolicyDrift,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
  type SessionWorkflowClient,
} from "@opengeni/core";
import {
  createConnection,
  createDb,
  createOrganizationApiKey,
  createScheduledTask,
  getScheduledTask,
  getScheduledTaskCreatorPolicy,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { permissionsRequiredByFirstPartyTools } from "../src/mcp/first-party-tool-permissions";
import { registerScheduledTaskRoutes } from "../src/routes/scheduled-tasks";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-scheduled-task-access-refresh");
  if (!shared) {
    available = false;
    console.warn("[scheduled-task-access-refresh] PostgreSQL unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

class FakeWorkflowClient implements SessionWorkflowClient {
  synced: unknown[] = [];
  async signalUserMessage(): Promise<void> {}
  async wakeSessionWorkflow(): Promise<void> {}
  async requestSessionWorkflowWakeDispatch(): Promise<void> {}
  async signalApprovalDecision(): Promise<void> {}
  async signalSessionControl(): Promise<void> {}
  async syncScheduledTask(input: unknown): Promise<void> {
    this.synced.push(input);
  }
  async deleteScheduledTaskSchedule(): Promise<void> {}
  async triggerScheduledTask(): Promise<void> {}
  async startRigVerification(): Promise<void> {}
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return testSettings({
    sandboxBackend: "none",
    defaultFirstPartyMcpTools: ["sessions_list", "rig_list", "browser_read"],
    mcpServers: [
      {
        id: "linear",
        name: "Linear",
        url: "https://linear.example.com/mcp",
        cacheToolsList: false,
        connectionRef: { providerDomain: "linear.app", kind: "oauth2", subjectScope: "workspace" },
      },
      {
        id: "notion",
        name: "Notion",
        url: "https://notion.example.com/mcp",
        cacheToolsList: false,
      },
    ],
    ...overrides,
  });
}

async function workspaceFixture() {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('scheduled access refresh') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name, settings)
    values (${account!.id}, 'Team', ${admin.json({
      sessionToolDefaults: { mcpServerIds: ["linear", "notion"] },
    })}) returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const owner = `user:owner-${crypto.randomUUID()}`;
  const member = `user:member-${crypto.randomUUID()}`;
  for (const subject of [owner, member]) {
    const [personal] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, ${`Personal ${subject}`}) returning id`;
    await admin`insert into workspace_inference_controls (workspace_id, account_id)
      values (${personal!.id}, ${account!.id})`;
    await admin`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
      values (${account!.id}, ${subject}, 'active', ${personal!.id})`;
    await admin`insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${account!.id}, ${workspace!.id}, ${subject})`;
  }
  const liveAccount = await createConnection(client.db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    subjectId: null,
    providerDomain: "linear.app",
    kind: "oauth2",
    credentialEncrypted: "not-read-by-metadata-selection",
  });
  return {
    accountId: account!.id,
    workspaceId: workspace!.id,
    owner,
    member,
    liveConnectionId: liveAccount.id,
  };
}

type Fixture = Awaited<ReturnType<typeof workspaceFixture>>;

const PERSON_PERMISSIONS: Permission[] = [
  "workspace:read",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "sessions:read",
  "sessions:create",
  "files:read",
];

function grant(workspace: Fixture, subjectId: string): AccessGrant {
  return {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId,
    principalKind: "human_session",
    permissions: PERSON_PERMISSIONS,
    metadata: {},
  };
}

function signedIn(
  workspace: Fixture,
  subjectId: string,
  overrides: Partial<AccessGrantAuthorization> = {},
): AccessGrantAuthorization {
  return {
    grant: grant(workspace, subjectId),
    accountGrant: null,
    authenticatedSubjectId: subjectId,
    contextIntegrity: true,
    canonicalManagedHumanSession: true,
    canonicalLocalHumanSession: false,
    ...overrides,
  };
}

/** An agent-created schedule, frozen before Notion, browser tools and a reconnected Linear. */
async function staleAgentTask(workspace: Fixture): Promise<ScheduledTask> {
  return await createScheduledTask(client.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    name: "Weekly Linear digest",
    status: "active",
    schedule: { type: "interval", everySeconds: 3_600 },
    temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: {
      prompt: "Summarize this week's Linear issues",
      resources: [],
      tools: [{ kind: "mcp", id: "linear" }],
      metadata: {},
      // The account chosen at creation was later disconnected and reconnected.
      connectionAccounts: [{ serverId: "linear", connectionId: crypto.randomUUID() }],
      connectionAccountsFrozen: true,
    },
    createdBy: { kind: "subject", subjectId: workspace.owner },
    creatorPolicy: {
      firstPartyMcpTools: ["sessions_list"],
      firstPartyMcpPermissions: ["sessions:read", "workspace:admin"],
      sessionPolicy: { agentAccess: "session", scopeSubjectId: null, memoryScope: null },
    },
    metadata: {},
  });
}

function deps(settingsValue: Settings): ApiRouteDeps {
  return {
    settings: settingsValue,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: new FakeWorkflowClient(),
    objectStorage: null,
    githubStateSecret: "test-state-secret",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services not used");
    },
    resumeBoxById: async () => {
      throw new Error("resumeBoxById not used");
    },
  } as unknown as ApiRouteDeps;
}

async function expectHttpError(work: Promise<unknown>, status: number, message: string) {
  let caught: unknown;
  try {
    await work;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HTTPException);
  expect((caught as HTTPException).status as number).toBe(status);
  expect((caught as HTTPException).message).toContain(message);
}

describe("scheduled task access drift and refresh", () => {
  test("names what is out of date only for the owner", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const task = await staleAgentTask(workspace);
    const [ownerView] = await withScheduledTaskPolicyDrift({
      db: client.db,
      settings: settings(),
      authorization: signedIn(workspace, workspace.owner),
      tasks: [task],
      permissionsRequiredByTools: permissionsRequiredByFirstPartyTools,
    });
    expect(ownerView?.policyDrift).toEqual({
      missingConnectors: [{ id: "notion", name: "Notion" }],
      unavailableConnectors: [],
      missingOpenGeniTools: ["rig_list", "browser_read"],
      unavailableAccounts: [{ id: "linear", name: "Linear" }],
      attachableAccounts: [],
      canRefresh: true,
    });
    const [memberView] = await withScheduledTaskPolicyDrift({
      db: client.db,
      settings: settings(),
      authorization: signedIn(workspace, workspace.member),
      tasks: [task],
      permissionsRequiredByTools: permissionsRequiredByFirstPartyTools,
    });
    expect(memberView).toEqual(task);
  }, 60_000);

  test("refuses keys, other members and a changed head before writing", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const task = await staleAgentTask(workspace);
    const refresh = (authorization: AccessGrantAuthorization, executionDigest: string) =>
      refreshScheduledTaskAccess({
        settings: settings(),
        db: client.db,
        objectStorage: null,
        authorization,
        taskId: task.id,
        request: { executionDigest },
        permissionsRequiredByTools: permissionsRequiredByFirstPartyTools,
      });
    await expectHttpError(
      refresh(
        signedIn(workspace, workspace.owner, { canonicalManagedHumanSession: false }),
        task.executionDigest,
      ),
      403,
      "Only a signed-in person",
    );
    await expectHttpError(
      refresh(signedIn(workspace, workspace.member), task.executionDigest),
      403,
      "Only the schedule owner",
    );
    await expectHttpError(
      refresh(signedIn(workspace, workspace.owner), "0".repeat(64)),
      409,
      "This schedule changed",
    );
    expect(await getScheduledTask(client.db, workspace.workspaceId, task.id)).toEqual(task);
  }, 60_000);

  test("re-freezes with the owner's current authority and never beyond it", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const task = await staleAgentTask(workspace);
    const refreshed = await refreshScheduledTaskAccess({
      settings: settings(),
      db: client.db,
      objectStorage: null,
      authorization: signedIn(workspace, workspace.owner),
      taskId: task.id,
      request: { executionDigest: task.executionDigest },
      permissionsRequiredByTools: permissionsRequiredByFirstPartyTools,
    });

    expect(refreshed.agentConfig.tools).toEqual([
      { kind: "mcp", id: "linear" },
      { kind: "mcp", id: "notion", optional: true },
    ]);
    expect(refreshed.agentConfig.connectionAccounts).toEqual([
      { serverId: "linear", connectionId: workspace.liveConnectionId },
    ]);
    expect(refreshed.agentConfig.connectionAccountsFrozen).toBe(true);
    expect(refreshed.ownerSubjectId).toBe(workspace.owner);
    expect(refreshed.authorityRevision).toBeGreaterThan(task.authorityRevision);
    expect(refreshed.executionDigest).not.toBe(task.executionDigest);

    const policy = await getScheduledTaskCreatorPolicy(client.db, workspace.workspaceId, task.id);
    expect(policy?.firstPartyMcpTools).toEqual(["sessions_list", "rig_list", "browser_read"]);
    // The frozen workspace:admin the refreshing person does not hold is gone,
    // and every permission kept or added is one that person holds.
    expect(policy?.firstPartyMcpPermissions).not.toContain("workspace:admin");
    for (const permission of policy?.firstPartyMcpPermissions ?? []) {
      expect(PERSON_PERMISSIONS).toContain(permission);
    }
    expect(policy?.firstPartyMcpPermissions).toContain("sessions:read");
    // Only what the added tools need is added: rig_list needs rigs:use, which
    // this person does not hold, and browser_read needs sessions:read. Nothing
    // else from the default worker set rides along.
    expect(policy?.firstPartyMcpPermissions).toEqual(["sessions:read"]);
    // The creator session policy is never rewritten by a refresh.
    expect(policy?.sessionPolicy).toEqual({
      agentAccess: "session",
      scopeSubjectId: null,
      memoryScope: null,
    });

    const [after] = await withScheduledTaskPolicyDrift({
      db: client.db,
      settings: settings(),
      authorization: signedIn(workspace, workspace.owner),
      tasks: [refreshed],
      permissionsRequiredByTools: permissionsRequiredByFirstPartyTools,
    });
    expect(after?.policyDrift).toBeNull();

    // Refreshing an up-to-date task is a no-op, not another re-authorization.
    const again = await refreshScheduledTaskAccess({
      settings: settings(),
      db: client.db,
      objectStorage: null,
      authorization: signedIn(workspace, workspace.owner),
      taskId: task.id,
      request: { executionDigest: refreshed.executionDigest },
      permissionsRequiredByTools: permissionsRequiredByFirstPartyTools,
    });
    expect(again.authorityRevision).toBe(refreshed.authorityRevision);
  }, 60_000);

  test("fixing an account never lifts a narrowed agent task's permission boundary", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    // A read-only agent session created this task with today's default tools;
    // only its Linear account is stale.
    const task = await createScheduledTask(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      name: "Read-only digest",
      status: "active",
      schedule: { type: "interval", everySeconds: 3_600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "Summarize",
        resources: [],
        tools: [
          { kind: "mcp", id: "linear" },
          { kind: "mcp", id: "notion", optional: true },
        ],
        metadata: {},
        connectionAccounts: [{ serverId: "linear", connectionId: crypto.randomUUID() }],
        connectionAccountsFrozen: true,
      },
      createdBy: { kind: "subject", subjectId: workspace.owner },
      creatorPolicy: {
        firstPartyMcpTools: ["sessions_list", "rig_list", "browser_read"],
        firstPartyMcpPermissions: ["sessions:read"],
        sessionPolicy: { agentAccess: "session", scopeSubjectId: null, memoryScope: null },
      },
      metadata: {},
    });
    const [view] = await withScheduledTaskPolicyDrift({
      db: client.db,
      settings: settings(),
      authorization: signedIn(workspace, workspace.owner),
      tasks: [task],
      permissionsRequiredByTools: permissionsRequiredByFirstPartyTools,
    });
    expect(view?.policyDrift).toMatchObject({
      missingConnectors: [],
      missingOpenGeniTools: [],
      unavailableAccounts: [{ id: "linear", name: "Linear" }],
    });
    const refreshed = await refreshScheduledTaskAccess({
      settings: settings(),
      db: client.db,
      objectStorage: null,
      authorization: signedIn(workspace, workspace.owner),
      taskId: task.id,
      request: { executionDigest: task.executionDigest },
      permissionsRequiredByTools: permissionsRequiredByFirstPartyTools,
    });
    expect(refreshed.agentConfig.connectionAccounts).toEqual([
      { serverId: "linear", connectionId: workspace.liveConnectionId },
    ]);
    const policy = await getScheduledTaskCreatorPolicy(client.db, workspace.workspaceId, task.id);
    expect(policy?.firstPartyMcpTools).toEqual(["sessions_list", "rig_list", "browser_read"]);
    expect(policy?.firstPartyMcpPermissions).toEqual(["sessions:read"]);
  }, 60_000);

  test("over HTTP an organization key sees drift on a task without an owner but cannot refresh", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const task = await createScheduledTask(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      name: "Service digest",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "Summarize",
        resources: [],
        tools: [],
        metadata: {},
        connectionAccounts: [],
        connectionAccountsFrozen: true,
      },
      createdBy: { kind: "service", subjectId: "scheduler" },
      metadata: {},
    });
    expect(task.ownerSubjectId).toBeNull();
    const token = randomBytes(24).toString("hex");
    await createOrganizationApiKey(client.db, {
      accountId: workspace.accountId,
      name: "Schedule fixture",
      prefix: "test",
      keyHash: createHash("sha256").update(token).digest("hex"),
      permissions: ["workspace:read", "scheduled_tasks:manage", "scheduled_tasks:run"],
    });
    const app = new Hono();
    app.onError((error, context) =>
      error instanceof HTTPException
        ? context.json({ message: error.message }, error.status as never)
        : context.json({ message: error.message }, 500),
    );
    registerScheduledTaskRoutes(app, deps(settings({ productAccessMode: "managed" })));
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const listed = await app.request(`/v1/workspaces/${workspace.workspaceId}/scheduled-tasks`, {
      headers,
    });
    expect(listed.status).toBe(200);
    const [view] = (await listed.json()) as ScheduledTask[];
    expect(view?.policyDrift).toEqual({
      missingConnectors: [
        { id: "linear", name: "Linear" },
        { id: "notion", name: "Notion" },
      ],
      unavailableConnectors: [],
      missingOpenGeniTools: [],
      unavailableAccounts: [],
      attachableAccounts: [],
      canRefresh: false,
    });

    // The literal path is its own route, never read as a task id.
    const attention = await app.request(
      `/v1/workspaces/${workspace.workspaceId}/scheduled-tasks/attention`,
      { headers },
    );
    expect(attention.status).toBe(200);
    expect(await attention.json()).toEqual({ tasks: [] });

    const refused = await app.request(
      `/v1/workspaces/${workspace.workspaceId}/scheduled-tasks/${task.id}/refresh-access`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ executionDigest: task.executionDigest }),
      },
    );
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("Only a signed-in person");
    expect(await getScheduledTask(client.db, workspace.workspaceId, task.id)).toEqual(task);
  }, 60_000);
});
