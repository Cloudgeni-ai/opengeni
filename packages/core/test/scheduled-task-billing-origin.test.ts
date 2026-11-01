import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import type { AccessGrant } from "@opengeni/contracts";
import {
  triggerScheduledTaskForGrant,
  updateScheduledTaskForApi,
  type SessionWorkflowClient,
} from "../src";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
const TASK = "00000000-0000-4000-8000-000000000003";

const keyGrant = {
  accountId: ACCOUNT,
  workspaceId: WORKSPACE,
  subjectId: "api-key:product",
  permissions: ["scheduled_tasks:run", "scheduled_tasks:manage"],
  principalKind: "api_key",
} as AccessGrant;
const personGrant = { ...keyGrant, subjectId: "user:person", principalKind: "human_session" };

const tx = {} as db.Database;
const fakeDb = {
  transaction: async (fn: (tx: db.Database) => Promise<unknown>) => await fn(tx),
} as unknown as db.Database;
const task = {
  id: TASK,
  accountId: ACCOUNT,
  workspaceId: WORKSPACE,
  status: "active",
  action: { kind: "agent_turn" },
  agentConfig: { metadata: {} },
} as unknown as Parameters<typeof triggerScheduledTaskForGrant>[3]["task"];

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});
function stubOwnership() {
  const owner = spyOn(db, "scheduledTaskMutationOwnerMatches").mockResolvedValue(true);
  const mark = spyOn(db, "markScheduledTaskApiBilled").mockResolvedValue();
  restores.push(
    () => owner.mockRestore(),
    () => mark.mockRestore(),
  );
  return mark;
}

describe("schedules an API caller uses are billed as API", () => {
  test("an API key's manual run marks the task API before the run starts", async () => {
    const mark = stubOwnership();
    const order: string[] = [];
    mark.mockImplementation(async () => void order.push("mark"));
    const workflowClient = {
      triggerScheduledTask: mock(async () => void order.push("trigger")),
    } as unknown as SessionWorkflowClient;
    await triggerScheduledTaskForGrant(fakeDb, keyGrant, workflowClient, {
      task,
      agentRunUsageIdempotencyKey: "usage",
      triggerWorkflowId: "workflow",
      initiator: { kind: "subject", subjectId: keyGrant.subjectId },
    });
    expect(mark).toHaveBeenCalledWith(tx, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      taskId: TASK,
    });
    expect(order).toEqual(["mark", "trigger"]);
  });

  test("a person's manual run in the app leaves the task's origin alone", async () => {
    const mark = stubOwnership();
    const workflowClient = {
      triggerScheduledTask: mock(async () => {}),
    } as unknown as SessionWorkflowClient;
    await db.withBillingOriginOverride("app", () =>
      triggerScheduledTaskForGrant(fakeDb, personGrant, workflowClient, {
        task,
        agentRunUsageIdempotencyKey: "usage",
        triggerWorkflowId: "workflow",
        initiator: { kind: "subject", subjectId: personGrant.subjectId },
      }),
    );
    expect(mark).not.toHaveBeenCalled();
    expect(workflowClient.triggerScheduledTask).toHaveBeenCalledTimes(1);
  });

  test("an API key's edit marks the task API; pausing does not", async () => {
    const mark = stubOwnership();
    const update = spyOn(db, "updateScheduledTask").mockImplementation(
      async (_db, _workspaceId, _taskId, input) => {
        await input.beforeUpdateCommit?.(tx);
        return task as never;
      },
    );
    restores.push(() => update.mockRestore());
    await updateScheduledTaskForApi(fakeDb, keyGrant, TASK, { status: "paused" });
    expect(mark).not.toHaveBeenCalled();
    await updateScheduledTaskForApi(fakeDb, keyGrant, TASK, {
      agentConfig: { prompt: "Spend plan credit" },
    } as never);
    expect(mark).toHaveBeenCalledWith(tx, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      taskId: TASK,
    });
  });
});
