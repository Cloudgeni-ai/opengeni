import { describe, expect, test } from "bun:test";
import {
  UpdateWorkspaceSettingsRequest,
  WorkspaceSettingsSchema,
  resolveWorkspaceMemoryPromptMode,
} from "../src";

describe("workspace Memory V1 prompt mode", () => {
  test("defaults to retrieval-only composition when the setting is absent or invalid", () => {
    expect(resolveWorkspaceMemoryPromptMode(undefined)).toBe("retrieval_only");
    expect(resolveWorkspaceMemoryPromptMode({})).toBe("retrieval_only");
    expect(resolveWorkspaceMemoryPromptMode({ memoryPromptMode: "future-mode" })).toBe(
      "retrieval_only",
    );
    expect(resolveWorkspaceMemoryPromptMode("not-an-object")).toBe("retrieval_only");
  });

  test("retires legacy standing composition without breaking a stored setting", () => {
    // A workspace that opted in before the retirement keeps the stored value in
    // its passthrough settings bag; it must simply stop meaning anything rather
    // than failing validation and taking the workspace down with it.
    expect(resolveWorkspaceMemoryPromptMode({ memoryPromptMode: "legacy_standing" })).toBe(
      "retrieval_only",
    );
    // It can no longer be selected.
    expect(
      UpdateWorkspaceSettingsRequest.safeParse({ memoryPromptMode: "legacy_standing" }).success,
    ).toBe(false);
  });

  test("accepts explicit retrieval-only", () => {
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
