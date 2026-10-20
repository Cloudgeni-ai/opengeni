import { describe, expect, test } from "bun:test";
import {
  CreateScheduledTaskRequest,
  UpdateScheduledTaskRequest,
  UpdateWorkspaceSettingsRequest,
  resolveWorkspaceDefaultExecutionTarget,
} from "../src";

const targetSandboxId = "00000000-0000-4000-8000-000000000022";
const base = {
  name: "Daily report",
  schedule: { type: "manual" },
  agentConfig: { prompt: "Summarize activity", executionTarget: "workspace_default" },
};

describe("workspace execution defaults", () => {
  test("stores an exact target and fails closed on malformed placement", () => {
    expect(
      UpdateWorkspaceSettingsRequest.parse({
        defaultExecutionTarget: { kind: "machine", targetSandboxId },
      }).defaultExecutionTarget,
    ).toEqual({ kind: "machine", targetSandboxId });
    expect(
      resolveWorkspaceDefaultExecutionTarget({ defaultExecutionTarget: { kind: "managed" } }),
    ).toEqual({ kind: "managed" });
    expect(resolveWorkspaceDefaultExecutionTarget({})).toBeNull();
    expect(resolveWorkspaceDefaultExecutionTarget({ defaultExecutionTarget: null })).toBeNull();
    expect(() =>
      resolveWorkspaceDefaultExecutionTarget({
        defaultExecutionTarget: { kind: "machine", targetSandboxId: "removed" },
      }),
    ).toThrow();
  });

  test("a schedule can follow the default only when it creates its own chat", () => {
    expect(CreateScheduledTaskRequest.parse(base).agentConfig.executionTarget).toBe(
      "workspace_default",
    );
    for (const override of [{ machineTarget: { targetSandboxId } }, { sandboxBackend: "none" }]) {
      expect(() =>
        CreateScheduledTaskRequest.parse({
          ...base,
          agentConfig: { ...base.agentConfig, ...override },
        }),
      ).toThrow();
    }
    expect(() =>
      CreateScheduledTaskRequest.parse({
        ...base,
        runMode: "existing_session",
        targetSessionId: targetSandboxId,
      }),
    ).toThrow();
    expect(() =>
      UpdateScheduledTaskRequest.parse({
        runMode: "existing_session",
        agentConfig: base.agentConfig,
      }),
    ).toThrow();
  });
});
