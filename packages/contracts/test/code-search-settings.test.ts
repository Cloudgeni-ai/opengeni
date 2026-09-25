import { describe, expect, test } from "bun:test";
import { UpdateWorkspaceSettingsRequest, WorkspaceSettingsSchema } from "../src/index";
import {
  codeSearchSessionInExperiment,
  resolveSessionCodeSearchEnabled,
  resolveWorkspaceCodeSearchMode,
  type CodeSearchDeploymentPolicy,
} from "../src/code-search";

const OFF: CodeSearchDeploymentPolicy = { available: false, workspaceDefault: "off" };
const OPT_IN: CodeSearchDeploymentPolicy = { available: true, workspaceDefault: "off" };
const DEFAULT_ON: CodeSearchDeploymentPolicy = { available: true, workspaceDefault: "on" };
const EXPERIMENT: CodeSearchDeploymentPolicy = { available: true, workspaceDefault: "split" };

describe("code_search workspace setting", () => {
  test("the deployment can always keep it off", () => {
    expect(resolveWorkspaceCodeSearchMode({ codeSearchEnabled: true }, OFF)).toBe("off");
    expect(resolveWorkspaceCodeSearchMode(undefined, OFF)).toBe("off");
  });

  test("an absent or null setting follows the deployment default", () => {
    expect(resolveWorkspaceCodeSearchMode(undefined, OPT_IN)).toBe("off");
    expect(resolveWorkspaceCodeSearchMode({}, DEFAULT_ON)).toBe("on");
    expect(resolveWorkspaceCodeSearchMode({ codeSearchEnabled: null }, DEFAULT_ON)).toBe("on");
    expect(resolveWorkspaceCodeSearchMode({}, EXPERIMENT)).toBe("split");
  });

  test("an explicit workspace choice wins when the deployment offers the tool", () => {
    expect(resolveWorkspaceCodeSearchMode({ codeSearchEnabled: true }, OPT_IN)).toBe("on");
    expect(resolveWorkspaceCodeSearchMode({ codeSearchEnabled: false }, DEFAULT_ON)).toBe("off");
    expect(resolveWorkspaceCodeSearchMode({ codeSearchEnabled: true }, EXPERIMENT)).toBe("on");
    expect(resolveWorkspaceCodeSearchMode({ codeSearchEnabled: false }, EXPERIMENT)).toBe("off");
  });

  test("a malformed settings bag follows the deployment default", () => {
    expect(resolveWorkspaceCodeSearchMode({ codeSearchEnabled: "yes" }, OPT_IN)).toBe("off");
    expect(resolveWorkspaceCodeSearchMode({ codeSearchEnabled: "yes" }, DEFAULT_ON)).toBe("on");
  });

  test("an invalid sibling setting does not hide an explicit choice", () => {
    const invalidSibling = { maxNestedAgentDepth: "deep", agentHumanInputEnabled: "sometimes" };
    expect(WorkspaceSettingsSchema.safeParse(invalidSibling).success).toBe(false);
    expect(
      resolveWorkspaceCodeSearchMode({ ...invalidSibling, codeSearchEnabled: false }, DEFAULT_ON),
    ).toBe("off");
    expect(
      resolveWorkspaceCodeSearchMode({ ...invalidSibling, codeSearchEnabled: true }, OPT_IN),
    ).toBe("on");
    expect(resolveWorkspaceCodeSearchMode(invalidSibling, DEFAULT_ON)).toBe("on");
    expect(
      resolveSessionCodeSearchEnabled(
        { ...invalidSibling, codeSearchEnabled: false },
        DEFAULT_ON,
        "session-1",
      ),
    ).toBe(false);
  });

  test("workspace settings and admin patch contracts accept booleans and null", () => {
    expect(WorkspaceSettingsSchema.safeParse({ codeSearchEnabled: true }).success).toBe(true);
    expect(WorkspaceSettingsSchema.safeParse({ codeSearchEnabled: null }).success).toBe(true);
    expect(UpdateWorkspaceSettingsRequest.safeParse({ codeSearchEnabled: false }).success).toBe(
      true,
    );
    expect(UpdateWorkspaceSettingsRequest.safeParse({ codeSearchEnabled: null }).success).toBe(
      true,
    );
    expect(UpdateWorkspaceSettingsRequest.safeParse({ codeSearchEnabled: "on" }).success).toBe(
      false,
    );
  });
});

describe("code_search per-session experiment", () => {
  const ids = Array.from(
    { length: 2_000 },
    (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
  );

  test("assigns about half of sessions and never changes a session's arm", () => {
    const inArm = ids.filter((id) => codeSearchSessionInExperiment(id)).length;
    expect(inArm).toBeGreaterThan(900);
    expect(inArm).toBeLessThan(1_100);
    for (const id of ids.slice(0, 50)) {
      expect(codeSearchSessionInExperiment(id)).toBe(codeSearchSessionInExperiment(id));
    }
  });

  test("only split workspaces use the arm; explicit settings apply to every session", () => {
    const on = ids.find((id) => codeSearchSessionInExperiment(id))!;
    const off = ids.find((id) => !codeSearchSessionInExperiment(id))!;
    expect(resolveSessionCodeSearchEnabled({}, EXPERIMENT, on)).toBe(true);
    expect(resolveSessionCodeSearchEnabled({}, EXPERIMENT, off)).toBe(false);
    expect(resolveSessionCodeSearchEnabled({ codeSearchEnabled: true }, EXPERIMENT, off)).toBe(
      true,
    );
    expect(resolveSessionCodeSearchEnabled({}, DEFAULT_ON, off)).toBe(true);
    expect(resolveSessionCodeSearchEnabled({}, OPT_IN, on)).toBe(false);
  });
});
