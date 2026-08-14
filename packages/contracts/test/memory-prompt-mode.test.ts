import { describe, expect, test } from "bun:test";
import {
  UpdateWorkspaceSettingsRequest,
  WorkspaceSettingsSchema,
  resolveWorkspaceMemoryPromptMode,
} from "../src";

describe("workspace Memory V1 prompt rollout", () => {
  test("preserves legacy standing composition when the setting is absent or invalid", () => {
    expect(resolveWorkspaceMemoryPromptMode({})).toBe("legacy_standing");
    expect(resolveWorkspaceMemoryPromptMode({ memoryPromptMode: "future-mode" })).toBe(
      "legacy_standing",
    );
  });

  test("accepts the reversible retrieval-only candidate", () => {
    expect(
      WorkspaceSettingsSchema.parse({ memoryEnabled: true, memoryPromptMode: "retrieval_only" })
        .memoryPromptMode,
    ).toBe("retrieval_only");
    expect(
      UpdateWorkspaceSettingsRequest.safeParse({ memoryPromptMode: "retrieval_only" }).success,
    ).toBe(true);
    expect(resolveWorkspaceMemoryPromptMode({ memoryPromptMode: "retrieval_only" })).toBe(
      "retrieval_only",
    );
  });
});
