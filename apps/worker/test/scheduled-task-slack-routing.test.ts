import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  OPENGENI_SLACK_BOT_SESSION_METADATA_KEY,
} from "@opengeni/contracts";
import {
  createConnection,
  createDb,
  createScheduledTask,
  getSession,
  listScheduledTaskRuns,
  listSessionEvents,
  revokeConnection,
  updateScheduledTask,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-slack-routing");
  if (!shared) {
    available = false;
    console.warn("[worker-scheduled-slack-routing] PostgreSQL unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function workspaceFixture() {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('worker scheduled Slack bot') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'worker scheduled Slack bot') returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function botConnection(workspace: Awaited<ReturnType<typeof workspaceFixture>>) {
  return await createConnection(client.db, {
    ...workspace,
    subjectId: null,
    providerDomain: "slack.com",
    kind: "app_install",
    credentialEncrypted: randomBytes(48).toString("base64"),
    grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
    verifiedInstallAt: new Date(0),
    verifiedInstallVersion: 1,
    metadata: {
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
      slackTeamId: "T_SCHEDULED_TEST",
      slackTeamName: "Scheduled test workspace",
      botUserId: "U_SCHEDULED_TEST",
      botId: "B_SCHEDULED_TEST",
      botDisplayName: "OpenGeni",
      verifiedAt: new Date(0).toISOString(),
    },
    createdBySubjectId: "subject-a",
  });
}

function activities() {
  return createScheduledTaskActivities(
    async () =>
      ({
        settings: testSettings({
          databaseUrl: shared!.appUrl,
          sandboxBackend: "none",
        }),
        db: client.db,
        bus: new MemoryEventBus(),
      }) as unknown as ActivityServices,
  );
}

async function taskFixture(
  workspace: Awaited<ReturnType<typeof workspaceFixture>>,
  connectionId: string,
  runMode: "new_session_per_run" | "reusable_session",
) {
  return await createScheduledTask(client.db, {
    ...workspace,
    name: `scheduled Slack routing ${runMode}`,
    status: "active",
    schedule: { type: "interval", everySeconds: 3_600 },
    temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
    runMode,
    overlapPolicy: "allow_concurrent",
    agentConfig: {
      prompt: "Use the explicitly selected OpenGeni Slack bot",
      resources: [],
      tools: [],
      metadata: {},
      slackBotConnectionId: connectionId,
    },
    metadata: {},
  });
}

describe("scheduled OpenGeni Slack bot routing", () => {
  test("binds the exact connection with safe creation evidence and revalidates revocation", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const connection = await botConnection(workspace);
    const task = await taskFixture(workspace, connection.id, "new_session_per_run");
    const worker = activities();

    const first = await worker.dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
    });
    expect(first.action).toBe("start");
    const session = await getSession(client.db, workspace.workspaceId, first.sessionId);
    expect(session?.metadata[OPENGENI_SLACK_BOT_SESSION_METADATA_KEY]).toBe(connection.id);

    const events = await listSessionEvents(
      client.db,
      workspace.workspaceId,
      first.sessionId,
      0,
      20,
    );
    const created = events.find((event) => event.type === "session.created");
    const payload = created?.payload as Record<string, unknown> | undefined;
    expect(payload).toMatchObject({
      slackBotConnection: {
        credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
        credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
        connectionId: connection.id,
        slackTeamId: "T_SCHEDULED_TEST",
      },
    });
    expect(
      Object.keys((payload?.slackBotConnection ?? {}) as Record<string, unknown>).sort(),
    ).toEqual(["connectionId", "credentialLabel", "credentialRole", "slackTeamId"]);

    await revokeConnection(client.db, workspace.workspaceId, connection.id, "subject-a");
    await expect(
      worker.dispatchScheduledTaskRun({
        workspaceId: workspace.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
      }),
    ).rejects.toThrow("not active (revoked)");
    expect(await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10)).toHaveLength(
      1,
    );
  });

  test("fails a reusable run when the durable task and session bindings diverge", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const connection = await botConnection(workspace);
    const task = await taskFixture(workspace, connection.id, "reusable_session");
    const worker = activities();

    const first = await worker.dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
    });
    expect(first.action).toBe("start");

    const unboundAgentConfig = { ...task.agentConfig };
    delete unboundAgentConfig.slackBotConnectionId;
    await updateScheduledTask(client.db, workspace.workspaceId, task.id, {
      agentConfig: unboundAgentConfig,
    });
    await expect(
      worker.dispatchScheduledTaskRun({
        workspaceId: workspace.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
      }),
    ).rejects.toThrow("binding does not match its reusable session");

    const runs = await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10);
    expect(runs.map((run) => run.status).sort()).toEqual(["dispatched", "failed"]);
  });
});
