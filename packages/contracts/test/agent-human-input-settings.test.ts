import { describe, expect, test } from "bun:test";
import {
  UpdateWorkspaceSettingsRequest,
  WorkspaceSettingsSchema,
  resolveWorkspaceAgentHumanInputEnabled,
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
