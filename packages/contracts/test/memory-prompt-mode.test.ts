import { describe, expect, test } from "bun:test";
import {
  UpdateWorkspaceSettingsRequest,
  WorkspaceSettingsSchema,
  resolveWorkspaceAgentHumanInputEnabled,
  resolveWorkspaceMemoryEnabled,
  resolveWorkspaceMemoryPromptMode,
} from "../src";

describe("workspace Memory V1 prompt mode", () => {
  test("defaults to retrieval-only composition when the setting is absent or invalid", () => {
    expect(resolveWorkspaceMemoryPromptMode()).toBe("retrieval_only");
  });

  test("a stored legacy_standing is ignored without poisoning the settings bag", () => {
    expect(resolveWorkspaceMemoryPromptMode()).toBe("retrieval_only");
    // The value must still PARSE. `.passthrough()` rescues unknown keys, not a
    // known key holding a rejected value, so narrowing the enum would fail the
    // whole bag and silently revert every other setting to its default. These
    // are the assertions that catch that: they are about the neighbours.
    const stored = { memoryPromptMode: "legacy_standing", agentHumanInputEnabled: false } as const;
    expect(WorkspaceSettingsSchema.safeParse(stored).success).toBe(true);
    expect(resolveWorkspaceAgentHumanInputEnabled(stored)).toBe(false);
    expect(
      resolveWorkspaceMemoryEnabled({ memoryPromptMode: "legacy_standing", memoryEnabled: true }),
    ).toBe(true);
    expect(
      UpdateWorkspaceSettingsRequest.safeParse({ memoryPromptMode: "legacy_standing" }).success,
    ).toBe(true);
  });

  test("accepts explicit retrieval-only", () => {
    expect(
      WorkspaceSettingsSchema.parse({ memoryEnabled: true, memoryPromptMode: "retrieval_only" })
        .memoryPromptMode,
    ).toBe("retrieval_only");
    expect(
      UpdateWorkspaceSettingsRequest.safeParse({ memoryPromptMode: "retrieval_only" }).success,
    ).toBe(true);
    expect(resolveWorkspaceMemoryPromptMode()).toBe("retrieval_only");
  });
});
