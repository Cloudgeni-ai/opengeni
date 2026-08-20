import { describe, expect, test } from "bun:test";

import {
  UpdateWorkspaceSettingsRequest,
  WorkspaceSettingsSchema,
  resolveWorkspaceSessionDefaults,
} from "../src";

describe("workspace session defaults", () => {
  test("stores a model and reasoning policy for new chats and schedules", () => {
    const sessionDefaults = {
      model: "codex/gpt-5.6-sol",
      reasoningEffort: "high",
    } as const;

    expect(WorkspaceSettingsSchema.parse({ sessionDefaults }).sessionDefaults).toEqual(
      sessionDefaults,
    );
    expect(UpdateWorkspaceSettingsRequest.safeParse({ sessionDefaults }).success).toBe(true);
    expect(resolveWorkspaceSessionDefaults({ sessionDefaults })).toEqual(sessionDefaults);
  });

  test("uses deployment defaults when no valid workspace preference exists", () => {
    expect(resolveWorkspaceSessionDefaults(undefined)).toBeNull();
    expect(
      resolveWorkspaceSessionDefaults({ sessionDefaults: { model: "", reasoningEffort: "high" } }),
    ).toBeNull();
    expect(
      UpdateWorkspaceSettingsRequest.safeParse({
        sessionDefaults: { model: "codex/gpt-5.6-sol", reasoningEffort: "maximum" },
      }).success,
    ).toBe(false);
  });
});
