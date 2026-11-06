import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CreateScheduledTaskRequest,
  KnowledgeSourceSyncAction,
  type AccessGrant,
  type Permission,
} from "@opengeni/contracts";
import { createValidatedScheduledTask } from "@opengeni/core";
import { createDb, listScheduledTaskRuns, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

/**
 * Integration Knowledge sync was removed. A stray sync schedule left by an
 * older release never runs: it is refused instead of starting an agent turn.
 */

let shared: SharedTestDatabase;
let client: DbClient;
const bus = new MemoryEventBus();

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("worker-scheduled-knowledge-source-refusal");
  if (!acquired) throw new Error("Scheduled Knowledge source refusal requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

function settings() {
  return testSettings({ databaseUrl: shared.appUrl, sandboxBackend: "none" });
}

let wakes = 0;
const scheduler = () =>
  createScheduledTaskActivities(
    async () =>
      ({
        settings: settings(),
        db: client.db,
        bus,
        wakeSessionWorkflow: async () => {
          wakes += 1;
        },
      }) as unknown as ActivityServices,
  );

const KEY_PERMISSIONS: Permission[] = [
  "workspace:read",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "sessions:read",
  "sessions:create",
  "sessions:control",
];

async function fixture() {
  const [account] = await shared.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('scheduled knowledge source refusal') returning id`;
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'Team') returning id`;
  await shared.admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const key: AccessGrant = {
    accountId: account!.id,
    workspaceId: workspace!.id,
    subjectId: `api_key:${crypto.randomUUID()}`,
    principalKind: "api_key",
    permissions: KEY_PERMISSIONS,
  };
  const task = await createValidatedScheduledTask({
    settings: settings(),
    db: client.db,
    objectStorage: null,
    grant: key,
    payload: CreateScheduledTaskRequest.parse({
      name: "Old Drive sync",
      schedule: { type: "calendar", hour: 7, minute: 0, timeZone: "UTC" },
      runMode: "new_session_per_run",
      overlapPolicy: "skip",
      agentConfig: { prompt: "Sync the folder" },
    }),
  });
  const action = KnowledgeSourceSyncAction.parse({
    kind: "knowledge_source_sync",
    sourceId: crypto.randomUUID(),
    sourceGeneration: 0,
    sourceLifecycleGeneration: 1,
    sourceConfigGeneration: 1,
    controlWorkspaceId: workspace!.id,
    providerCoordinationKey: "googleapis.com:folder",
    connection: {
      connectionId: crypto.randomUUID(),
      connectionVersion: 1,
      providerDomain: "googleapis.com",
      kind: "oauth2",
      ownerSubjectId: key.subjectId,
    },
    destination: { kind: "workspace", workspaceId: workspace!.id, subjectId: null },
    initiatingSubjectId: key.subjectId,
  });
  return { workspaceId: workspace!.id, taskId: task.id, action };
}

async function fire(workspace: Awaited<ReturnType<typeof fixture>>) {
  return scheduler().dispatchScheduledTaskRun({
    workspaceId: workspace.workspaceId,
    taskId: workspace.taskId,
    triggerType: "scheduled",
    producerKey: `knowledge-source-refusal:${crypto.randomUUID()}`,
  });
}

async function expectRefused(workspace: Awaited<ReturnType<typeof fixture>>) {
  const wakesBefore = wakes;
  expect(await fire(workspace)).toEqual({
    action: "blocked",
    reason: "scheduled_execution_unrepresentable",
  });
  expect(await listScheduledTaskRuns(client.db, workspace.workspaceId, workspace.taskId)).toEqual(
    [],
  );
  expect(wakes).toBe(wakesBefore);
  const [sessions] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from sessions where workspace_id = ${workspace.workspaceId}`;
  expect(sessions?.count).toBe(0);
}

describe("a stray Knowledge source sync schedule", () => {
  test("a knowledge_source_sync action is refused and starts no chat", async () => {
    const workspace = await fixture();
    // The action kind is immutable today; an older release wrote this row.
    await shared.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`update scheduled_tasks
        set action = ${sql.json(workspace.action)}
        where id = ${workspace.taskId}`;
    });
    await expectRefused(workspace);
  }, 180_000);

  test("an agent turn carrying agentConfig.knowledgeSource is refused and starts no chat", async () => {
    const workspace = await fixture();
    await shared.admin`update scheduled_tasks
      set agent_config = agent_config || ${shared.admin.json({ knowledgeSource: workspace.action })}
      where id = ${workspace.taskId}`;
    await expectRefused(workspace);
  }, 180_000);
});
