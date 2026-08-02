import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { McpPersonalConnectionDelegation } from "@opengeni/contracts";
import { captureScheduledTaskRestoreState, syncUpdatedScheduledTask } from "@opengeni/core";
import {
  claimSessionWorkForAttempt,
  createDb,
  createRig,
  createScheduledTask,
  createSession,
  createVariableSet,
  getScheduledTask,
  getScheduledTaskPersonalConnectionDelegations,
  listSessionSystemUpdatesForTurn,
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
  shared = await acquireSharedTestDatabase("worker-scheduled-personal-authority");
  if (!shared) {
    available = false;
    console.warn("[worker-scheduled-personal-authority] PostgreSQL unavailable, skipping");
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
    insert into managed_accounts (name) values ('scheduled personal authority') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'scheduled personal authority') returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return {
    accountId: account!.id,
    workspaceId: workspace!.id,
    subjectId: `subject-${crypto.randomUUID()}`,
  };
}

function delegation(
  subjectId: string,
  serverId: string,
  providerDomain: string,
): McpPersonalConnectionDelegation[] {
  return [
    {
      serverId,
      connectionId: crypto.randomUUID(),
      ownerSubjectId: subjectId,
      providerDomain,
      kind: "oauth2",
    },
  ];
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

describe("scheduled task personal MCP authority", () => {
  test("an accepted occurrence keeps the task snapshot even if the task changes afterward", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const acceptedDelegations = delegation(workspace.subjectId, "linear", "linear.app");
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "freeze accepted occurrence",
      status: "active",
      schedule: { type: "interval", everySeconds: 3_600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "Run with the accepted personal connection snapshot",
        resources: [],
        tools: [],
        metadata: {},
      },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      personalConnectionDelegations: acceptedDelegations,
      metadata: {},
    });

    const dispatched = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
    });
    expect(dispatched.action).toBe("start");

    const laterDelegations = delegation(workspace.subjectId, "github", "github.com");
    await updateScheduledTask(client.db, workspace.workspaceId, task.id, {
      personalConnectionDelegations: laterDelegations,
      agentConfig: {
        ...task.agentConfig,
        prompt: "Changed only after the earlier occurrence was accepted",
      },
    });

    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, workspace.workspaceId, {
      sessionId: dispatched.sessionId,
      workflowId: dispatched.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error("scheduled occurrence was not claimed");
    expect(claimed.turn.personalConnectionDelegations).toEqual(acceptedDelegations);
    expect(
      await listSessionSystemUpdatesForTurn(
        client.db,
        workspace.workspaceId,
        dispatched.sessionId,
        claimed.turn.id,
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "scheduled_occurrence",
        summary: "Run with the accepted personal connection snapshot",
      }),
    ]);

    const [stored] = await admin<
      Array<{
        session_authority: McpPersonalConnectionDelegation[];
        occurrence_authority: McpPersonalConnectionDelegation[];
      }>
    >`
      select
        sessions.initial_personal_connection_delegations as session_authority,
        updates.personal_connection_delegations as occurrence_authority
      from sessions
      join session_system_updates updates on updates.session_id = sessions.id
      where sessions.id = ${dispatched.sessionId}
        and updates.kind = 'scheduled_occurrence'
    `;
    expect(stored).toEqual({
      session_authority: acceptedDelegations,
      occurrence_authority: acceptedDelegations,
    });
    expect(
      await getScheduledTaskPersonalConnectionDelegations(
        client.db,
        workspace.workspaceId,
        task.id,
      ),
    ).toEqual(laterDelegations);
  });

  test("Temporal sync failure restores every execution-affecting task field", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const originalDelegations = delegation(workspace.subjectId, "linear", "linear.app");
    const variableSet = await createVariableSet(client.db, {
      ...workspace,
      name: "scheduled restore variables",
    });
    const rig = await createRig(client.db, {
      ...workspace,
      name: "scheduled restore rig",
      createdBy: workspace.subjectId,
    });
    const reusableSession = await createSession(client.db, {
      ...workspace,
      initialMessage: "reusable scheduled session",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const created = await createScheduledTask(client.db, {
      ...workspace,
      name: "restore complete task snapshot",
      status: "paused",
      schedule: { type: "interval", everySeconds: 1_800 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "reusable_session",
      overlapPolicy: "buffer_one",
      agentConfig: {
        prompt: "original prompt",
        resources: [],
        tools: [],
        metadata: { version: "original" },
      },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      personalConnectionDelegations: originalDelegations,
      variableSetId: variableSet.id,
      rigId: rig.id,
      metadata: { version: "original" },
    });
    const original = await updateScheduledTask(client.db, workspace.workspaceId, created.id, {
      reusableSessionId: reusableSession.id,
    });
    const restoreState = await captureScheduledTaskRestoreState(client.db, original);
    const changedDelegations = delegation(workspace.subjectId, "github", "github.com");
    const changed = await updateScheduledTask(client.db, workspace.workspaceId, original.id, {
      name: "changed name",
      status: "active",
      schedule: { type: "interval", everySeconds: 7_200 },
      runMode: "new_session_per_run",
      overlapPolicy: "skip",
      agentConfig: {
        prompt: "changed prompt",
        resources: [],
        tools: [],
        metadata: { version: "changed" },
      },
      personalConnectionDelegations: changedDelegations,
      reusableSessionId: null,
      variableSetId: null,
      rigId: null,
      metadata: { version: "changed" },
    });

    await expect(
      syncUpdatedScheduledTask({
        db: client.db,
        previous: restoreState,
        task: changed,
        workflowClient: {
          syncScheduledTask: async () => {
            throw new Error("expected Temporal synchronization failure");
          },
        } as never,
      }),
    ).rejects.toThrow("expected Temporal synchronization failure");

    const restored = await getScheduledTask(client.db, workspace.workspaceId, original.id);
    expect(restored).toMatchObject({
      name: original.name,
      status: original.status,
      schedule: original.schedule,
      runMode: original.runMode,
      overlapPolicy: original.overlapPolicy,
      agentConfig: original.agentConfig,
      reusableSessionId: reusableSession.id,
      variableSetId: variableSet.id,
      rigId: rig.id,
      metadata: original.metadata,
    });
    expect(
      await getScheduledTaskPersonalConnectionDelegations(
        client.db,
        workspace.workspaceId,
        original.id,
      ),
    ).toEqual(originalDelegations);
  });
});
