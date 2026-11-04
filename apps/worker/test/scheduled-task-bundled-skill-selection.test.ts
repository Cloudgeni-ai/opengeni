import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bundledSkillSelectionFromMetadata,
  CreateScheduledTaskRequest,
  type AccessGrant,
  type Permission,
} from "@opengeni/contracts";
import { createValidatedScheduledTask } from "@opengeni/core";
import { createDb, getSession, listScheduledTaskRuns, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import postgres from "postgres";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

/**
 * A task that starts its own chats may choose which bundled Skills they get,
 * including none. The chat stores that choice, and the database fence that
 * checks each generated chat against the accepted run must expect it, for a
 * scheduled occurrence and a manual run alike.
 */

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-task-bundled-skill-selection");
  if (!shared) {
    available = false;
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("Scheduled task bundled Skill selection verification requires PostgreSQL");
    }
    console.warn(
      "[worker-scheduled-task-bundled-skill-selection] PostgreSQL unavailable, skipping",
    );
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

function settings() {
  return testSettings({ databaseUrl: shared!.appUrl, sandboxBackend: "none" });
}

function scheduler() {
  return createScheduledTaskActivities(
    async () =>
      ({
        settings: settings(),
        db: client.db,
        bus: new MemoryEventBus(),
        wakeSessionWorkflow: async () => undefined,
      }) as unknown as ActivityServices,
  );
}

async function workspaceFixture() {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('scheduled bundled skills') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'Team workspace') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

const KEY_PERMISSIONS: Permission[] = [
  "workspace:read",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "sessions:read",
  "sessions:create",
];

function serviceKey(workspace: { accountId: string; workspaceId: string }): AccessGrant {
  return {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId: `api_key:${crypto.randomUUID()}`,
    subjectLabel: "Service backend",
    principalKind: "api_key",
    permissions: KEY_PERMISSIONS,
  };
}

describe("a task's bundled Skill selection on the chats it starts", () => {
  for (const [label, bundledSkillIds] of [
    ["no bundled Skills", []],
    ["one bundled Skill", ["builtin:visualize"]],
  ] as const) {
    for (const triggerType of ["scheduled", "manual"] as const) {
      test(`${label}: a ${triggerType} run starts its chat`, async () => {
        if (!available) return;
        const workspace = await workspaceFixture();
        const key = serviceKey(workspace);
        const task = await createValidatedScheduledTask({
          settings: settings(),
          db: client.db,
          objectStorage: null,
          grant: key,
          payload: CreateScheduledTaskRequest.parse({
            name: "Nightly review",
            schedule: { type: "interval", everySeconds: 3600 },
            runMode: "new_session_per_run",
            agentConfig: {
              prompt: "Review the open work",
              bundledSkillIds,
              agent: { capabilities: { from: "none", skills: "read" } },
            },
          }),
        });
        expect(task.agentConfig.bundledSkillIds).toEqual([...bundledSkillIds]);

        const dispatched = await scheduler().dispatchScheduledTaskRun({
          workspaceId: workspace.workspaceId,
          taskId: task.id,
          triggerType,
          producerKey: `bundled-skills:${crypto.randomUUID()}`,
          ...(triggerType === "manual"
            ? {
                initiator: { kind: "subject" as const, subjectId: key.subjectId },
                agentRunUsageIdempotencyKey: `manual:${crypto.randomUUID()}`,
              }
            : {}),
        });
        expect(dispatched).toMatchObject({ action: "start" });

        const [run] = await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10);
        expect(run).toMatchObject({ status: "dispatched", error: null });
        const session = await getSession(client.db, workspace.workspaceId, run!.sessionId!);
        expect(bundledSkillSelectionFromMetadata(session!.metadata)).toEqual([...bundledSkillIds]);
      }, 180_000);
    }
  }
});
