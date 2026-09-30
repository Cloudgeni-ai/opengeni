import { describe, expect, spyOn, test } from "bun:test";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { registerScheduledTaskRoutes } from "../src/routes/scheduled-tasks";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
const TASK = "00000000-0000-4000-8000-000000000003";
const OWNER = "user:schedule-owner";

describe("manual schedule allowance attribution", () => {
  test.each([
    { name: "human-owned schedule", owner: OWNER, authority: OWNER, expected: OWNER },
    { name: "pure service schedule", owner: null, authority: null, expected: null },
    { name: "unavailable human authority", owner: OWNER, authority: null, expected: null },
    { name: "mismatched human authority", owner: OWNER, authority: "user:other", expected: null },
  ])(
    "HTTP edge retains $name rather than the triggering administrator",
    async ({ owner, authority, expected }) => {
      const settings = testSettings({ billingMode: "disabled", usageLimitsMode: "none" });
      const deps = {
        db: {} as db.Database,
        settings,
        bus: {} as never,
        workflowClient: {} as never,
        objectStorage: null,
      } as core.ApiRouteDeps;
      const grant = {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        subjectId: "user:triggering-administrator",
        permissions: ["scheduled_tasks:run" as const],
        principalKind: "human_session" as const,
      };
      const access = spyOn(core, "requireAccessGrant").mockResolvedValue(grant);
      const task = spyOn(core, "requireScheduledTaskForApi").mockResolvedValue({
        id: TASK,
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        authorityRevision: 7,
        ownerSubjectId: owner,
        action: { kind: "agent_turn" },
        runMode: "new_session_per_run",
        agentConfig: {},
      } as Awaited<ReturnType<typeof core.requireScheduledTaskForApi>>);
      const catalog = spyOn(core, "resolveWorkspaceCatalogSettings").mockResolvedValue({
        settings,
      } as Awaited<ReturnType<typeof core.resolveWorkspaceCatalogSettings>>);
      const target = spyOn(core, "validateScheduledTaskTarget").mockResolvedValue(null);
      const machine = spyOn(core, "validateScheduledTaskMachineTarget").mockResolvedValue();
      const frozen = spyOn(db, "getScheduledTaskRevisionAuthoritySubject").mockResolvedValue(
        authority,
      );
      const model = spyOn(core, "resolveScheduledTaskPreflightModel").mockResolvedValue(
        "scripted-model",
      );
      const codex = spyOn(db, "isCodexBilledTurn").mockResolvedValue(false);
      const allowance = spyOn(db, "checkWorkspaceAllowance").mockResolvedValue({
        code: "allowance_exhausted",
        scope: expected ? "member" : "workspace",
        resetsAt: null,
        ...(expected ? { subjectId: expected } : {}),
        message: "Exhausted",
      });
      const trigger = spyOn(core, "triggerScheduledTaskForGrant").mockResolvedValue();
      const app = new Hono();
      registerScheduledTaskRoutes(app, deps);
      try {
        const response = await app.request(
          `/v1/workspaces/${WORKSPACE}/scheduled-tasks/${TASK}/trigger`,
          { method: "POST" },
        );
        expect(response.status).toBe(402);
        expect(frozen).toHaveBeenCalledWith(deps.db, {
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          taskId: TASK,
          taskAuthorityRevision: 7,
        });
        expect(allowance).toHaveBeenCalledWith(deps.db, {
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          subjectId: expected,
        });
        expect(trigger).not.toHaveBeenCalled();
      } finally {
        access.mockRestore();
        task.mockRestore();
        catalog.mockRestore();
        target.mockRestore();
        machine.mockRestore();
        frozen.mockRestore();
        model.mockRestore();
        codex.mockRestore();
        allowance.mockRestore();
        trigger.mockRestore();
      }
    },
  );

  test("MCP trigger uses the task revision authority and the resolved catalog before admission", async () => {
    const source = await Bun.file(new URL("../src/mcp/server.ts", import.meta.url)).text();
    const trigger = source.indexOf('"scheduled_tasks_trigger"');
    const authority = source.indexOf("getScheduledTaskRevisionAuthoritySubject(deps.db,", trigger);
    const limit = source.indexOf(
      "await requireLimit({ ...deps, settings: catalogSettings },",
      authority,
    );
    const dispatch = source.indexOf("await triggerScheduledTaskForGrant(", limit);
    expect(authority).toBeGreaterThan(trigger);
    expect(limit).toBeGreaterThan(authority);
    expect(dispatch).toBeGreaterThan(limit);
    expect(source.slice(limit, dispatch)).toContain(
      "taskAuthoritySubjectId === task.ownerSubjectId ? taskAuthoritySubjectId : null",
    );
  });
});
