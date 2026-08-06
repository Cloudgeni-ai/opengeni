import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type {
  AccessGrant,
  ScheduledTask,
  ScheduledTaskAgentConfig,
  Session,
} from "@opengeni/contracts";
import * as db from "@opengeni/db";
import {
  scheduledTaskForGrant,
  scheduledTaskRunForGrant,
  validateScheduledTaskTarget,
} from "@opengeni/core";

const accountId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const targetSessionId = "00000000-0000-4000-8000-000000000003";
const baseConfig: ScheduledTaskAgentConfig = {
  prompt: "Continue the current work",
  resources: [],
  tools: [],
  metadata: {},
};
const manageOnly: AccessGrant = {
  accountId,
  workspaceId,
  subjectId: "subject-1",
  permissions: ["scheduled_tasks:manage", "scheduled_tasks:run"],
};
const manageAndControl: AccessGrant = {
  ...manageOnly,
  permissions: [...manageOnly.permissions, "sessions:control"],
};
const baseSession = {
  id: targetSessionId,
  accountId,
  workspaceId,
  status: "idle",
  sandboxBackend: "none",
  variableSetId: null,
  rigId: null,
  metadata: {},
} as Session;

function task(): ScheduledTask {
  return {
    id: "00000000-0000-4000-8000-000000000004",
    accountId,
    workspaceId,
    name: "Continue one session",
    status: "active",
    schedule: { type: "interval", everySeconds: 3600 },
    temporalScheduleId: "scheduled-task-existing-session",
    runMode: "existing_session",
    overlapPolicy: "allow_concurrent",
    agentConfig: baseConfig,
    targetSessionId,
    reusableSessionId: null,
    variableSetId: null,
    environmentId: null,
    rigId: null,
    metadata: {},
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  };
}

afterEach(() => mock.restore());

describe("scheduled existing-session authorization", () => {
  test("redacts target and run session IDs without sessions:control", () => {
    expect(scheduledTaskForGrant(task(), manageOnly).targetSessionId).toBeNull();
    expect(scheduledTaskForGrant(task(), manageAndControl).targetSessionId).toBe(targetSessionId);
    expect(
      scheduledTaskRunForGrant({ sessionId: targetSessionId, status: "dispatched" }, manageOnly)
        .sessionId,
    ).toBeNull();
  });

  test("requires sessions:control before any target lookup", async () => {
    const lookup = spyOn(db, "getSession").mockResolvedValue(baseSession);
    await expect(
      validateScheduledTaskTarget({
        db: {} as never,
        grant: manageOnly,
        targetSessionId,
        runMode: "existing_session",
        variableSetId: null,
        rigId: null,
        agentConfig: baseConfig,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(lookup).not.toHaveBeenCalled();
  });

  test("accepts only a revivable matching target and fails closed otherwise", async () => {
    spyOn(db, "getSlackInteractionSessionAccessForSession").mockResolvedValue(null);
    const lookup = spyOn(db, "getSession").mockResolvedValue(baseSession);
    await expect(
      validateScheduledTaskTarget({
        db: {} as never,
        grant: manageAndControl,
        targetSessionId,
        runMode: "existing_session",
        variableSetId: null,
        rigId: null,
        agentConfig: baseConfig,
      }),
    ).resolves.toEqual(baseSession);

    lookup.mockResolvedValue(null);
    await expect(
      validateScheduledTaskTarget({
        db: {} as never,
        grant: manageAndControl,
        targetSessionId,
        runMode: "existing_session",
        variableSetId: null,
        rigId: null,
        agentConfig: baseConfig,
      }),
    ).rejects.toMatchObject({ status: 404 });

    lookup.mockResolvedValue({ ...baseSession, status: "cancelled" });
    await expect(
      validateScheduledTaskTarget({
        db: {} as never,
        grant: manageAndControl,
        targetSessionId,
        runMode: "existing_session",
        variableSetId: null,
        rigId: null,
        agentConfig: baseConfig,
      }),
    ).rejects.toMatchObject({ status: 409 });

    lookup.mockResolvedValue({ ...baseSession, variableSetId: crypto.randomUUID() });
    await expect(
      validateScheduledTaskTarget({
        db: {} as never,
        grant: manageAndControl,
        targetSessionId,
        runMode: "existing_session",
        variableSetId: null,
        rigId: null,
        agentConfig: baseConfig,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  test("rejects goal replacement and orphaned trigger targets", async () => {
    await expect(
      validateScheduledTaskTarget({
        db: {} as never,
        grant: manageAndControl,
        targetSessionId,
        runMode: "existing_session",
        variableSetId: null,
        rigId: null,
        agentConfig: { ...baseConfig, goal: { text: "Replace the target goal" } },
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      validateScheduledTaskTarget({
        db: {} as never,
        grant: manageAndControl,
        targetSessionId: null,
        runMode: "existing_session",
        variableSetId: null,
        rigId: null,
        agentConfig: baseConfig,
        missingTargetStatus: 404,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
