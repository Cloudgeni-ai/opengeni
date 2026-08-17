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

  test("keeps legacy standing composition only as an explicit opt-out", () => {
    expect(resolveWorkspaceMemoryPromptMode({ memoryPromptMode: "legacy_standing" })).toBe(
      "legacy_standing",
    );
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
    expect(resolveWorkspaceMemoryPromptMode({ memoryPromptMode: "retrieval_only" })).toBe(
      "retrieval_only",
    );
  });
});
