import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createDb,
  createScheduledTask,
  getScheduledTask,
  getScheduledTaskBlockers,
  listScheduledTaskRuns,
  updateOrganizationMember,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import postgres from "postgres";
import { reviewScheduledTaskBlockerInventory } from "../../api/src/scheduled-task-blockers";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

/**
 * An automation runs under the exact organization membership revision its
 * owner saved it with. An edit that leaves the owner's access as it was must
 * not stop it; a change that does stop it must pause it and tell the owner
 * what to do, instead of failing every occurrence while it keeps "running".
 */

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
const bus = new MemoryEventBus();

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-owner-authority-change");
  if (!shared) {
    available = false;
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("Scheduled owner authority verification requires PostgreSQL");
    }
    console.warn("[worker-scheduled-owner-authority-change] PostgreSQL unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

const scheduler = () =>
  createScheduledTaskActivities(
    async () =>
      ({
        settings: testSettings({ databaseUrl: shared!.appUrl, sandboxBackend: "none" }),
        db: client.db,
        bus,
        wakeSessionWorkflow: async () => undefined,
      }) as unknown as ActivityServices,
  );

async function ownedAutomation() {
  const subjectId = `user:${crypto.randomUUID()}`;
  const administratorSubjectId = `user:${crypto.randomUUID()}`;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('scheduled owner authority') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'Team') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const [membership] = await admin<{ id: string }[]>`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${account!.id}, ${subjectId}, 'admin', 'active', ${workspace!.id})
    returning id`;
  const [administratorWorkspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'Personal') returning id`;
  await admin`insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${account!.id}, ${administratorSubjectId}, 'owner', 'active', ${administratorWorkspace!.id})`;
  await admin`insert into workspace_memberships (account_id, workspace_id, subject_id)
    values (${account!.id}, ${workspace!.id}, ${subjectId})`;
  const fixture = { accountId: account!.id, workspaceId: workspace!.id, subjectId };
  const task = await createScheduledTask(client.db, {
    ...fixture,
    name: "Daily review",
    status: "active",
    schedule: { type: "interval", everySeconds: 86_400 },
    temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: { prompt: "Review the day", resources: [], tools: [], metadata: {} },
    createdBy: { kind: "subject", subjectId },
    metadata: {},
  });
  return {
    ...fixture,
    administratorSubjectId,
    membershipId: membership!.id,
    taskId: task.id,
  };
}

type Automation = Awaited<ReturnType<typeof ownedAutomation>>;

function fire(automation: Automation) {
  return scheduler().dispatchScheduledTaskRun({
    workspaceId: automation.workspaceId,
    taskId: automation.taskId,
    triggerType: "scheduled",
    producerKey: `owner-authority:${crypto.randomUUID()}`,
  });
}

async function membershipRevision(automation: Automation): Promise<number> {
  const [row] = await admin<{ revision: string }[]>`
    select authorization_revision::text as revision from organization_memberships
    where id = ${automation.membershipId}`;
  return Number(row!.revision);
}

describe("an automation whose owner's membership is edited after it was saved", () => {
  test("keeps running when the edit leaves their role as it was", async () => {
    if (!available) return;
    const automation = await ownedAutomation();
    expect((await fire(automation)).action).toBe("start");
    const before = await membershipRevision(automation);
    const member = await updateOrganizationMember(client.db, {
      organizationId: automation.accountId,
      actorSubjectId: automation.administratorSubjectId,
      operationId: crypto.randomUUID(),
      membershipId: automation.membershipId,
      transition: {
        kind: "change_role",
        role: "admin",
        expectedAuthorizationRevision: before,
        operationId: crypto.randomUUID(),
      },
    });
    expect(member).toMatchObject({ role: "admin", authorizationRevision: before });
    expect(await membershipRevision(automation)).toBe(before);
    expect((await fire(automation)).action).toBe("start");
    const runs = await listScheduledTaskRuns(client.db, automation.workspaceId, automation.taskId);
    expect(runs.map((run) => run.error)).toEqual([null, null]);
  }, 180_000);

  test("pauses itself and tells its owner to save it again when its saved access no longer holds", async () => {
    if (!available) return;
    const automation = await ownedAutomation();
    expect((await fire(automation)).action).toBe("start");

    // A real role change still advances the revision the task was saved with.
    await updateOrganizationMember(client.db, {
      organizationId: automation.accountId,
      actorSubjectId: automation.administratorSubjectId,
      operationId: crypto.randomUUID(),
      membershipId: automation.membershipId,
      transition: {
        kind: "change_role",
        role: "member",
        expectedAuthorizationRevision: await membershipRevision(automation),
        operationId: crypto.randomUUID(),
      },
    });
    expect(await fire(automation)).toEqual({ action: "blocked", reason: "scheduled_run_terminal" });
    const refused = (
      await listScheduledTaskRuns(client.db, automation.workspaceId, automation.taskId)
    ).find((run) => run.status === "failed");
    expect(refused).toMatchObject({
      error: "scheduled_run_authority_proof_rejected",
      sessionId: null,
    });

    await reviewScheduledTaskBlockerInventory({ db: client.db, bus });
    expect(
      (await getScheduledTask(client.db, automation.workspaceId, automation.taskId))?.status,
    ).toBe("paused");
    const blocker = (
      await getScheduledTaskBlockers(client.db, automation.workspaceId, [automation.taskId])
    ).get(automation.taskId);
    expect(blocker).toMatchObject({
      state: "paused",
      reason: "scheduled_run_authority_proof_rejected",
    });
    expect(blocker?.message).toContain("The access it was saved with has changed");
  }, 180_000);
});
