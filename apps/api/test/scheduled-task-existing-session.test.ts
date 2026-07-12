import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { HTTPException } from "hono/http-exception";
import type { AccessGrant, ScheduledTaskAgentConfig, Session } from "@opengeni/contracts";
import * as db from "@opengeni/db";
import { validateScheduledTaskTarget } from "@opengeni/core";

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
  db.getSession.mockRestore();
});

describe("scheduled existing-session target validation", () => {
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
