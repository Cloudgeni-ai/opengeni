import { describe, expect, test } from "bun:test";
import {
  UpdateWorkspaceSettingsRequest,
  WorkspaceSettingsSchema,
  resolveWorkspaceAgentHumanInputEnabled,
  resolveWorkspaceAgentWebSearchEnabled,
} from "../src/index";

describe("agent structured human-input workspace setting", () => {
  test("defaults enabled and honors an explicit disable", () => {
    expect(resolveWorkspaceAgentHumanInputEnabled(undefined)).toBe(true);
    expect(resolveWorkspaceAgentHumanInputEnabled({})).toBe(true);
    expect(resolveWorkspaceAgentHumanInputEnabled({ agentHumanInputEnabled: true })).toBe(true);
    expect(resolveWorkspaceAgentHumanInputEnabled({ agentHumanInputEnabled: false })).toBe(false);
  });

  test("workspace settings and admin patch contracts accept only booleans", () => {
    expect(WorkspaceSettingsSchema.safeParse({ agentHumanInputEnabled: false }).success).toBe(true);
    expect(
      UpdateWorkspaceSettingsRequest.safeParse({ agentHumanInputEnabled: false }).success,
    ).toBe(true);
    expect(
      UpdateWorkspaceSettingsRequest.safeParse({ agentHumanInputEnabled: "false" }).success,
    ).toBe(false);
  });
});

describe("agent hosted web-search workspace setting", () => {
  test("defaults permitted and honors an explicit switch-off", () => {
    expect(resolveWorkspaceAgentWebSearchEnabled(undefined)).toBe(true);
    expect(resolveWorkspaceAgentWebSearchEnabled({})).toBe(true);
    expect(resolveWorkspaceAgentWebSearchEnabled({ agentWebSearchEnabled: false })).toBe(false);
    expect(
      UpdateWorkspaceSettingsRequest.safeParse({ agentWebSearchEnabled: "false" }).success,
    ).toBe(false);
  });
});
