import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CreateScheduledTaskRequest,
  UpdateScheduledTaskRequest,
  type AccessGrant,
  type Permission,
} from "@opengeni/contracts";
import { createValidatedScheduledTask, validatedScheduledTaskUpdate } from "@opengeni/core";
import {
  createDb,
  createRig,
  createSession,
  createVariableSet,
  getScheduledTask,
  getScheduledTaskRunAcceptedExecution,
  listScheduledTaskRuns,
  requireSession,
  setWorkspaceDefaultRig,
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

// A scheduled task resolves an omitted Sandbox Environment once, at creation,
// the same way session create does, and every generated session rides the
// environment frozen on the task. Real PostgreSQL: creation goes through the
// validated task writer and dispatch through the worker activity.

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;

const settings = testSettings({
  sandboxBackend: "none",
  environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
});

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-default-environment");
  if (!shared) {
    available = false;
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("Scheduled task environment verification requires PostgreSQL");
    }
    console.warn("[worker-scheduled-default-environment] PostgreSQL unavailable, skipping");
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
    insert into managed_accounts (name) values ('scheduled default environment') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'scheduled default environment') returning id`;
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

type Workspace = Awaited<ReturnType<typeof workspaceFixture>>;

function grantFor(
  workspace: Workspace,
  permissions: Permission[] = ["workspace:admin"],
): AccessGrant {
  return { ...workspace, principalKind: "human_session", permissions } as AccessGrant;
}

async function seedRig(workspace: Workspace, name: string, defaultVariableSetIds: string[] = []) {
  return await createRig(client.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    name,
    createdBy: "user:test",
    initialVersion: { changelog: "v1", defaultVariableSetIds },
  });
}

async function createTask(
  workspace: Workspace,
  extra: Record<string, unknown> = {},
  grant: AccessGrant = grantFor(workspace),
) {
  return await createValidatedScheduledTask({
    settings,
    db: client.db,
    objectStorage: null,
    grant,
    toolsProvided: true,
    payload: CreateScheduledTaskRequest.parse({
      name: `environment ${crypto.randomUUID()}`,
      schedule: { type: "manual" },
      agentConfig: { prompt: "report on the environment", tools: [] },
      ...extra,
    }),
  });
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

describe("scheduled task default Sandbox Environment", () => {
  test("an omitted environment freezes the workspace default at creation and every run rides it", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const credentials = await createVariableSet(client.db, {
      ...workspace,
      scope: "workspace",
      name: "shared credentials",
    });
    const workspaceDefault = await seedRig(workspace, "analytics", [credentials.id]);
    await setWorkspaceDefaultRig(client.db, workspace.workspaceId, workspaceDefault.id);

    const task = await createTask(workspace);
    expect(task.rigId).toBe(workspaceDefault.id);

    // Changing the workspace default later does not move an existing task.
    const laterDefault = await seedRig(workspace, "later default");
    await setWorkspaceDefaultRig(client.db, workspace.workspaceId, laterDefault.id);
    expect((await getScheduledTask(client.db, workspace.workspaceId, task.id))?.rigId).toBe(
      workspaceDefault.id,
    );

    const dispatched = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `default-environment-${crypto.randomUUID()}`,
    });
    expect(dispatched.action).toBe("start");
    if (dispatched.action !== "start") return;
    const session = await requireSession(client.db, workspace.workspaceId, dispatched.sessionId);
    // The generated session carries the environment, so its default
    // Variable Sets are layered into every turn of the run.
    expect(session.rigId).toBe(workspaceDefault.id);
    expect(session.rigVersionId).toBe(workspaceDefault.activeVersion!.id);
  }, 60_000);

  test("explicit choices win, and no default or a stale default means none", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    expect((await createTask(workspace)).rigId).toBeNull();

    const workspaceDefault = await seedRig(workspace, "default");
    const other = await seedRig(workspace, "other");
    await setWorkspaceDefaultRig(client.db, workspace.workspaceId, workspaceDefault.id);
    expect((await createTask(workspace, { rigId: other.id })).rigId).toBe(other.id);
    expect((await createTask(workspace, { rigId: null })).rigId).toBeNull();

    // A default with no active version degrades to none, as for sessions.
    await admin`update rig_versions set active = false where rig_id = ${workspaceDefault.id}`;
    expect((await createTask(workspace)).rigId).toBeNull();
  }, 60_000);

  test("a default never gives a task Variable Sets its creator could not attach", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const credentials = await createVariableSet(client.db, {
      ...workspace,
      scope: "workspace",
      name: "restricted credentials",
    });
    const workspaceDefault = await seedRig(workspace, "with secrets", [credentials.id]);
    await setWorkspaceDefaultRig(client.db, workspace.workspaceId, workspaceDefault.id);

    const manageOnly = grantFor(workspace, ["scheduled_tasks:manage"]);
    await expect(createTask(workspace, {}, manageOnly)).rejects.toMatchObject({ status: 403 });
    // The same creator may still opt out explicitly.
    expect((await createTask(workspace, { rigId: null }, manageOnly)).rigId).toBeNull();
  }, 60_000);

  test("an explicit environment needs the same Variable Set authority as the default", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const credentials = await createVariableSet(client.db, {
      ...workspace,
      scope: "workspace",
      name: "restricted credentials",
    });
    const withSecrets = await seedRig(workspace, "with secrets", [credentials.id]);
    const manageOnly = grantFor(workspace, ["scheduled_tasks:manage"]);
    const update = (
      existing: Awaited<ReturnType<typeof createTask>>,
      payload: Record<string, unknown>,
      grant: AccessGrant,
    ) =>
      validatedScheduledTaskUpdate({
        settings,
        db: client.db,
        objectStorage: null,
        grant,
        existing,
        payload: UpdateScheduledTaskRequest.parse(payload),
      });

    // Naming the environment on create or edit binds its Variable Sets to
    // every generated session, so it is refused like the omitted default.
    await expect(
      createTask(workspace, { rigId: withSecrets.id }, manageOnly),
    ).rejects.toMatchObject({ status: 403 });
    const plain = await createTask(workspace, { rigId: null }, manageOnly);
    await expect(update(plain, { rigId: withSecrets.id }, manageOnly)).rejects.toMatchObject({
      status: 403,
    });
    expect((await update(plain, { rigId: withSecrets.id }, grantFor(workspace))).rigId).toBe(
      withSecrets.id,
    );

    // An existing-session task adopts its target's environment without a
    // new binding. Turning it into a generated-session task binds that
    // environment to fresh sessions, so the same check applies.
    const target = await createSession(client.db, {
      ...workspace,
      initialMessage: "target with secrets",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      rigId: withSecrets.id,
      rigVersionId: withSecrets.activeVersion!.id,
    });
    const adopted = await createTask(workspace, {
      runMode: "existing_session",
      targetSessionId: target.id,
    });
    expect(adopted.rigId).toBeNull();
    await expect(
      update(
        adopted,
        { runMode: "new_session_per_run", targetSessionId: null, rigId: withSecrets.id },
        manageOnly,
      ),
    ).rejects.toMatchObject({ status: 403 });
  }, 60_000);

  test("an existing-session task inherits its target environment without duplicating its binding", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const workspaceDefault = await seedRig(workspace, "default");
    const targetEnvironment = await seedRig(workspace, "target");
    const credentials = await createVariableSet(client.db, {
      ...workspace,
      scope: "workspace",
      name: "target credentials",
    });
    await setWorkspaceDefaultRig(client.db, workspace.workspaceId, workspaceDefault.id);
    const target = await createSession(client.db, {
      ...workspace,
      initialMessage: "long-running target",
      variableSetId: credentials.id,
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      rigId: targetEnvironment.id,
      rigVersionId: targetEnvironment.activeVersion!.id,
    });

    const task = await createTask(workspace, {
      runMode: "existing_session",
      targetSessionId: target.id,
    });
    expect(task.rigId).toBeNull();
    expect(task.variableSetId).toBeNull();
    const producerKey = `existing-message-${crypto.randomUUID()}`;
    const input = {
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled" as const,
      producerKey,
    };
    const dispatched = await activities().dispatchScheduledTaskRun(input);
    expect(dispatched.action).toBe("signal");
    if (dispatched.action !== "signal") throw new Error("Existing-chat dispatch refused");
    expect(dispatched.sessionId).toBe(target.id);
    const [run] = await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10);
    const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
      workspaceId: workspace.workspaceId,
      runId: run!.id,
    });
    expect(accepted?.targetSessionExecution?.model).toBe(target.model);
    expect(accepted?.targetSessionExecution?.variableSets.map((set) => set.id)).toContain(
      credentials.id,
    );
    expect((await requireSession(client.db, workspace.workspaceId, target.id)).rigId).toBe(
      targetEnvironment.id,
    );
    // Redelivery recovers the same occurrence without comparing the target's
    // attachments to the intentionally empty task defaults.
    const recovered = await activities().dispatchScheduledTaskRun(input);
    expect(["signal", "already_dispatched"]).toContain(recovered.action);
    expect(await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10)).toHaveLength(
      1,
    );
    // An explicit mismatch is still refused.
    await expect(
      createTask(workspace, {
        runMode: "existing_session",
        targetSessionId: target.id,
        rigId: workspaceDefault.id,
      }),
    ).rejects.toMatchObject({ status: 422 });
  }, 60_000);
});
