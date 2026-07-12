import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { HTTPException } from "hono/http-exception";
import type { AccessGrant, ScheduledTaskAgentConfig, Session } from "@opengeni/contracts";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import {
  scheduledTaskForGrant,
  validateScheduledTaskTarget,
  validatedScheduledTaskUpdate,
} from "@opengeni/core";

const targetSessionId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const baseSession = {
  id: targetSessionId,
  workspaceId,
  status: "idle",
  sandboxBackend: "none",
  variableSetId: null,
  rigId: null,
} as Session;
const baseConfig = {
  prompt: "continue",
  resources: [],
  tools: [],
  metadata: {},
} as ScheduledTaskAgentConfig;
const manageOnly: AccessGrant = {
  accountId: "00000000-0000-4000-8000-000000000003",
  workspaceId,
  subjectId: "subject",
  permissions: ["scheduled_tasks:manage"],
};
const manageAndControl: AccessGrant = {
  ...manageOnly,
  permissions: ["scheduled_tasks:manage", "sessions:control"],
};

afterEach(() => {
  for (const mock of [
    db.getSession,
    db.listEnabledMcpCapabilityServers,
    db.getWorkspaceModelPolicy,
  ]) {
    if (typeof mock.mockRestore === "function") {
      mock.mockRestore();
    }
  }
});

describe("scheduled existing-session target validation", () => {
  const task = (patch: Record<string, unknown> = {}) =>
    ({
      id: "00000000-0000-4000-8000-000000000010",
      accountId: manageOnly.accountId,
      workspaceId,
      name: "task",
      status: "active",
      schedule: { type: "interval", everySeconds: 3600 },
      temporalScheduleId: "scheduled-task-1",
      runMode: "reusable_session",
      overlapPolicy: "allow_concurrent",
      agentConfig: baseConfig,
      reusableSessionId: null,
      targetSessionId: null,
      variableSetId: null,
      environmentId: null,
      rigId: null,
      metadata: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...patch,
    }) as never;

  test("redacts target IDs from schedule responses without session control", () => {
    expect(scheduledTaskForGrant(task({ targetSessionId }), manageOnly).targetSessionId).toBeNull();
    expect(scheduledTaskForGrant(task({ targetSessionId }), manageAndControl).targetSessionId).toBe(
      targetSessionId,
    );
  });

  test("an explicit null is a no-op when already null, but clearing a target needs control", async () => {
    await expect(
      validatedScheduledTaskUpdate({
        settings: {} as never,
        db: {} as never,
        objectStorage: null,
        grant: manageOnly,
        existing: task(),
        payload: { targetSessionId: null },
      }),
    ).resolves.toMatchObject({ targetSessionId: null });
    await expect(
      validatedScheduledTaskUpdate({
        settings: {} as never,
        db: {} as never,
        objectStorage: null,
        grant: manageOnly,
        existing: task({ targetSessionId }),
        payload: { targetSessionId: null },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("does not orphan a task-owned session or drop config on a target-only edit", async () => {
    await expect(
      validatedScheduledTaskUpdate({
        settings: {} as never,
        db: {} as never,
        objectStorage: null,
        grant: manageAndControl,
        existing: task({ reusableSessionId: targetSessionId }),
        payload: { targetSessionId },
      }),
    ).rejects.toMatchObject({ status: 409 });

    spyOn(db, "getSession").mockResolvedValue(baseSession);
    const existing = task({
      targetSessionId,
      agentConfig: { ...baseConfig, model: "scripted-model" },
    });
    const update = await validatedScheduledTaskUpdate({
      settings: {} as never,
      db: {} as never,
      objectStorage: null,
      grant: manageAndControl,
      existing,
      payload: { targetSessionId },
    });
    expect(update.agentConfig).toEqual({
      ...baseConfig,
      model: "scripted-model",
      sandboxBackend: "none",
    });
  });

  test("rejects targeted scheduled goals instead of deferring the failure to fire time", async () => {
    spyOn(db, "getSession").mockResolvedValue(baseSession);
    spyOn(db, "listEnabledMcpCapabilityServers").mockResolvedValue([]);
    spyOn(db, "getWorkspaceModelPolicy").mockResolvedValue(null);
    const hiddenGoal = { text: "keep it", successCriteria: "done" };
    const existing = task({
      targetSessionId,
      agentConfig: { ...baseConfig, goal: hiddenGoal },
    });
    await expect(
      validatedScheduledTaskUpdate({
        settings: testSettings(),
        db: {} as never,
        objectStorage: null,
        grant: manageAndControl,
        existing,
        payload: { agentConfig: { ...baseConfig } },
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      validatedScheduledTaskUpdate({
        settings: testSettings(),
        db: {} as never,
        objectStorage: null,
        grant: manageAndControl,
        existing,
        payload: { agentConfig: { ...baseConfig, goal: { text: "replace it" } } },
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  test("requires session-control authorization before looking up the target", async () => {
    const lookup = spyOn(db, "getSession").mockResolvedValue(baseSession);
    await expect(
      validateScheduledTaskTarget({
        db: {} as never,
        grant: manageOnly,
        targetSessionId,
        runMode: "reusable_session",
        variableSetId: null,
        rigId: null,
        agentConfig: baseConfig,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(lookup).not.toHaveBeenCalled();
  });

  test("does not distinguish a missing or foreign target from an inaccessible session", async () => {
    spyOn(db, "getSession").mockResolvedValue(null);
    await expect(
      validateScheduledTaskTarget({
        db: {} as never,
        grant: manageAndControl,
        targetSessionId,
        runMode: "reusable_session",
        variableSetId: null,
        rigId: null,
        agentConfig: baseConfig,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("rejects cancelled targets and immutable attachment mismatches", async () => {
    spyOn(db, "getSession").mockResolvedValue({ ...baseSession, status: "cancelled" });
    await expect(
      validateScheduledTaskTarget({
        db: {} as never,
        grant: manageAndControl,
        targetSessionId,
        runMode: "reusable_session",
        variableSetId: null,
        rigId: null,
        agentConfig: baseConfig,
      }),
    ).rejects.toMatchObject({ status: 409 });

    db.getSession.mockResolvedValue({
      ...baseSession,
      variableSetId: "00000000-0000-4000-8000-000000000004",
    });
    await expect(
      validateScheduledTaskTarget({
        db: {} as never,
        grant: manageAndControl,
        targetSessionId,
        runMode: "reusable_session",
        variableSetId: null,
        rigId: null,
        agentConfig: baseConfig,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  test("accepts a revivable target with matching null attachments", async () => {
    spyOn(db, "getSession").mockResolvedValue(baseSession);
    await expect(
      validateScheduledTaskTarget({
        db: {} as never,
        grant: manageAndControl,
        targetSessionId,
        runMode: "reusable_session",
        variableSetId: null,
        rigId: null,
        agentConfig: baseConfig,
      }),
    ).resolves.toEqual(baseSession);
  });

  test("rejects a target on a different sandbox route", async () => {
    spyOn(db, "getSession").mockResolvedValue({ ...baseSession, sandboxBackend: "docker" });
    await expect(
      validateScheduledTaskTarget({
        db: {} as never,
        grant: manageAndControl,
        targetSessionId,
        runMode: "reusable_session",
        variableSetId: null,
        rigId: null,
        agentConfig: { ...baseConfig, sandboxBackend: "modal" },
      }),
    ).rejects.toBeInstanceOf(HTTPException);
  });
});
