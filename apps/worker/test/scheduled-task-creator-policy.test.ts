import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_FIRST_PARTY_MCP_PERMISSIONS } from "@opengeni/contracts";
import { resolveFirstPartyMcpToolPolicy } from "@opengeni/config";
import {
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  getScheduledTaskRunAcceptedExecution,
  getSession,
  listScheduledTaskRuns,
  type DbClient,
  type ScheduledTaskCreatorPolicy,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-creator-policy");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("scheduled-task creator policy tests require real PostgreSQL");
    }
    available = false;
    console.warn("[worker-scheduled-creator-policy] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

function activities(settingsOverrides: Parameters<typeof testSettings>[0] = {}) {
  const settings = testSettings({
    databaseUrl: shared!.appUrl,
    sandboxBackend: "none",
    ...settingsOverrides,
  });
  return {
    settings,
    activities: createScheduledTaskActivities(
      async () =>
        ({
          settings,
          db: client.db,
          bus: new MemoryEventBus(),
          wakeSessionWorkflow: async () => undefined,
        }) as unknown as ActivityServices,
    ),
  };
}

async function workspaceGrant() {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `scheduled-creator-account-${crypto.randomUUID()}`,
    accountName: "Scheduled creator policy account",
    workspaceExternalSource: "test",
    workspaceExternalId: `scheduled-creator-workspace-${crypto.randomUUID()}`,
    workspaceName: "Scheduled creator policy workspace",
    subjectId: "user:scheduled-creator-owner",
  });
  return access.workspaceGrants[0]!;
}

async function generatedTask(
  grant: Awaited<ReturnType<typeof workspaceGrant>>,
  creatorPolicy: ScheduledTaskCreatorPolicy | null,
) {
  return await createScheduledTask(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    name: "Generated session creator policy",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `scheduled-creator-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: {
      prompt: "Run with the creator's boundary",
      resources: [],
      tools: [],
      metadata: {},
    },
    metadata: {},
    creatorPolicy,
  });
}

async function dispatchGeneratedSession(
  grant: Awaited<ReturnType<typeof workspaceGrant>>,
  taskId: string,
  settingsOverrides: Parameters<typeof testSettings>[0] = {},
) {
  const { settings, activities: scheduled } = activities(settingsOverrides);
  const result = await scheduled.dispatchScheduledTaskRun({
    workspaceId: grant.workspaceId,
    taskId,
    triggerType: "scheduled",
    producerKey: `scheduled-creator-${crypto.randomUUID()}`,
  });
  if (result.action !== "start" && result.action !== "signal") {
    throw new Error(`unexpected dispatch result: ${JSON.stringify(result)}`);
  }
  const session = await getSession(client.db, grant.workspaceId, result.sessionId);
  if (!session) throw new Error("generated session missing");
  const [run] = await listScheduledTaskRuns(client.db, grant.workspaceId, taskId, 10);
  const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
    workspaceId: grant.workspaceId,
    runId: run!.id,
  });
  return { settings, session, accepted };
}

describe("scheduled-task creator policy inheritance (real PostgreSQL)", () => {
  test("a human/API-created task keeps the deployment default for its generated session", async () => {
    if (!available) return;
    const grant = await workspaceGrant();
    const task = await generatedTask(grant, null);
    const { settings, session, accepted } = await dispatchGeneratedSession(grant, task.id);
    expect(session.firstPartyMcpTools).toEqual(resolveFirstPartyMcpToolPolicy(settings).default);
    expect(session.firstPartyMcpPermissions).toEqual([...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS]);
    expect(accepted?.resolvedFirstPartyMcpTools).toEqual(
      resolveFirstPartyMcpToolPolicy(settings).default,
    );
    expect(accepted?.resolvedFirstPartyMcpPermissions).toEqual([
      ...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
    ]);
  }, 60_000);

  test("an agent-created task's generated session inherits the frozen creator boundary", async () => {
    if (!available) return;
    // The hole: a narrowed session (title tool only, read-only permissions)
    // could schedule a task whose generated sessions received the complete
    // deployment default catalog and the full worker permission set.
    const grant = await workspaceGrant();
    const task = await generatedTask(grant, {
      firstPartyMcpTools: ["set_session_title", "scheduled_tasks_list"],
      firstPartyMcpPermissions: ["sessions:read", "scheduled_tasks:manage"],
      sessionPolicy: { agentAccess: null, scopeSubjectId: null, memoryScope: null },
    });
    const { settings, session, accepted } = await dispatchGeneratedSession(grant, task.id);
    expect(session.firstPartyMcpTools).toEqual(["set_session_title", "scheduled_tasks_list"]);
    expect(session.firstPartyMcpPermissions).toEqual(["sessions:read", "scheduled_tasks:manage"]);
    expect(accepted?.resolvedFirstPartyMcpTools).toEqual([
      "set_session_title",
      "scheduled_tasks_list",
    ]);
    expect(accepted?.resolvedFirstPartyMcpPermissions).toEqual([
      "sessions:read",
      "scheduled_tasks:manage",
    ]);
    expect(resolveFirstPartyMcpToolPolicy(settings).default.length).toBeGreaterThan(2);
  }, 60_000);

  test("the deployment ceiling still applies on top of the frozen creator selection", async () => {
    if (!available) return;
    const grant = await workspaceGrant();
    const task = await generatedTask(grant, {
      firstPartyMcpTools: ["set_session_title", "scheduled_tasks_list", "sessions_list"],
      firstPartyMcpPermissions: ["sessions:read"],
      sessionPolicy: null,
    });
    const { session } = await dispatchGeneratedSession(grant, task.id, {
      allowedFirstPartyMcpTools: ["set_session_title", "sessions_list"],
    });
    expect(session.firstPartyMcpTools).toEqual(["set_session_title", "sessions_list"]);
    expect(session.firstPartyMcpPermissions).toEqual(["sessions:read"]);
  }, 60_000);
});
