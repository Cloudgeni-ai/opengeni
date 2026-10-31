import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  CreateScheduledTaskRequest,
  SCHEDULED_TASK_ACCEPTED_EXECUTION_MAX_BYTES,
  type AccessGrant,
} from "@opengeni/contracts";
import { createValidatedScheduledTask } from "@opengeni/core";
import {
  createDb,
  getScheduledTaskRunAcceptedExecution,
  listScheduledTaskRuns,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import postgres from "postgres";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

// A task's inline Skills are bounded by the Skill limits it was saved under, so
// a task that passed ingress is always accepted for a run: the Skills do not
// count against the accepted execution byte cap.

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;

const settings = testSettings({ sandboxBackend: "none" });

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-inline-skills");
  if (!shared) {
    available = false;
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("Scheduled task inline Skill verification requires PostgreSQL");
    }
    console.warn("[worker-scheduled-inline-skills] PostgreSQL unavailable, skipping");
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
    insert into managed_accounts (name) values ('scheduled inline skills') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'scheduled inline skills') returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const fixture = {
    accountId: account!.id,
    workspaceId: workspace!.id,
    subjectId: `subject-${crypto.randomUUID()}`,
  };
  await admin`
    insert into organization_memberships (
      account_id, subject_id, status, personal_workspace_id
    ) values (
      ${fixture.accountId}, ${fixture.subjectId}, 'active', ${fixture.workspaceId}
    )`;
  await admin`insert into workspace_memberships (account_id, workspace_id, subject_id)
    values (${fixture.accountId}, ${fixture.workspaceId}, ${fixture.subjectId})`;
  return fixture;
}

function activities() {
  return createScheduledTaskActivities(
    async () =>
      ({
        settings: testSettings({ databaseUrl: shared!.appUrl, sandboxBackend: "none" }),
        db: client.db,
        bus: new MemoryEventBus(),
      }) as unknown as ActivityServices,
  );
}

test("a task whose inline Skills exceed the accepted execution cap still runs", async () => {
  if (!available) return;
  const workspace = await workspaceFixture();
  // 32 Skills of about 19 KB each: about 600 KB, more than the accepted cap.
  const skills = Array.from({ length: 32 }, (_, index) => ({
    files: [
      {
        path: "SKILL.md",
        content: `---\nname: review-step-${index}\ndescription: Review step ${index}.\n---\n${"r".repeat(19_000)}\n`,
      },
    ],
  }));
  expect(new TextEncoder().encode(JSON.stringify(skills)).byteLength).toBeGreaterThan(
    SCHEDULED_TASK_ACCEPTED_EXECUTION_MAX_BYTES,
  );
  const task = await createValidatedScheduledTask({
    settings,
    db: client.db,
    objectStorage: null,
    grant: {
      ...workspace,
      principalKind: "human_session",
      permissions: ["workspace:admin"],
    } as AccessGrant,
    toolsProvided: true,
    payload: CreateScheduledTaskRequest.parse({
      name: "Nightly review",
      schedule: { type: "manual" },
      runMode: "new_session_per_run",
      agentConfig: { prompt: "Review the open work", tools: [], skills },
    }),
  });
  expect(task.agentConfig.skills).toHaveLength(32);

  const dispatched = await activities().dispatchScheduledTaskRun({
    workspaceId: workspace.workspaceId,
    taskId: task.id,
    triggerType: "scheduled",
    producerKey: `inline-skills-${crypto.randomUUID()}`,
  });
  expect(dispatched).toMatchObject({ action: "start" });
  const [run] = await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id);
  const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
    workspaceId: workspace.workspaceId,
    runId: run!.id,
  });
  expect(accepted?.task.agentConfig.skills).toHaveLength(32);
}, 60_000);
