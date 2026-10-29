import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sessionMetadataUnattended } from "@opengeni/contracts";
import {
  createDb,
  createScheduledTask,
  endSessionUnattendedDefault,
  getSession,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

// A chat a scheduled task starts is unattended unless the task says otherwise
// or chose to answer its approvals (real PostgreSQL, real dispatch). Only the
// default ends when a person writes; the task's explicit choice stays.

let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-unattended");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("Scheduled unattended tests require PostgreSQL");
    }
    console.warn("[worker-scheduled-unattended] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

describe("scheduled runs and attendance", () => {
  test.each([
    ["by default", {}, true, false],
    ["unless the task says unattended: false", { unattended: false }, false, false],
    ["unless the task answers its approvals", { approvalTimeoutSeconds: 600 }, false, false],
    [
      "when the task says so even with an approval timeout",
      { approvalTimeoutSeconds: 600, unattended: true },
      true,
      true,
    ],
  ] as const)(
    "a generated run chat is unattended %s",
    async (_label, config, expected, afterPerson) => {
      if (!shared) return;
      const admin = shared.admin;
      const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('worker scheduled unattended') returning id`;
      const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'worker scheduled unattended') returning id`;
      await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}, ${account!.id})`;
      const task = await createScheduledTask(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        name: "scheduled attendance",
        status: "active",
        schedule: { type: "interval", everySeconds: 3_600 },
        temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: {
          prompt: "run without anyone watching",
          resources: [],
          tools: [],
          metadata: {},
          ...config,
        },
        metadata: {},
      });
      const activities = createScheduledTaskActivities(
        async () =>
          ({
            settings: testSettings({ databaseUrl: shared!.appUrl, sandboxBackend: "none" }),
            db: client.db,
            bus: new MemoryEventBus(),
            wakeSessionWorkflow: async () => undefined,
          }) as unknown as ActivityServices,
      );
      const result = await activities.dispatchScheduledTaskRun({
        workspaceId: workspace!.id,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey: `unattended-${crypto.randomUUID()}`,
      });
      expect(result.action).toBe("start");
      if (result.action !== "start") return;
      const session = await getSession(client.db, workspace!.id, result.sessionId);
      expect(session?.unattended).toBe(expected);
      // The stored create stays the scheduler's own (no metadata marker); the
      // read shows the frozen "started unattended" fact under the same marker.
      const [stored] = await admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from sessions where id = ${result.sessionId}`;
      expect(stored?.metadata).not.toHaveProperty("_opengeniUnattended");
      expect(sessionMetadataUnattended(session?.metadata)).toBe(expected);
      // A person writes in the chat.
      await endSessionUnattendedDefault(client.db, {
        workspaceId: workspace!.id,
        sessionId: result.sessionId,
      });
      const later = await getSession(client.db, workspace!.id, result.sessionId);
      expect(later?.unattended).toBe(afterPerson);
      // How the chat started never changes, so its instructions and tools stay.
      expect(sessionMetadataUnattended(later?.metadata)).toBe(expected);
    },
    60_000,
  );
});
