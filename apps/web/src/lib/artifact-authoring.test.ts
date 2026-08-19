import { describe, expect, test } from "bun:test";

import {
  applyNewSessionModelPreference,
  artifactCreateOpeningMessage,
  artifactEditInstructions,
  artifactEditOpeningMessage,
} from "./artifact-authoring";

describe("artifact authoring sessions", () => {
  test("create opening does not name the create tool", () => {
    expect(artifactCreateOpeningMessage()).not.toContain("artifacts_create");
  });

  test("edit instructions bind the exact artifact and version", () => {
    const opening = artifactEditOpeningMessage("Status board");
    const instructions = artifactEditInstructions({
      artifactId: "artifact-1",
      title: "Status board",
      currentVersionId: "version-2",
    });

    expect(opening).toBe("Help me edit “Status board”.");
    expect(opening).not.toContain("artifact id");
    expect(instructions).toContain("artifact id artifact-1");
    expect(instructions).toContain("current version version-2");
  });

  test("applies the durable model preference without replacing an explicit choice", () => {
    expect(
      applyNewSessionModelPreference(
        { text: "Edit this artifact" },
        { model: "codex/gpt-5.6-sol", reasoningEffort: "medium" },
      ),
    ).toMatchObject({
      model: "codex/gpt-5.6-sol",
      reasoningEffort: "medium",
    });
    expect(
      applyNewSessionModelPreference(
        {
          text: "Edit this artifact",
          model: "azure/gpt-5.6-terra",
          reasoningEffort: "high",
        },
        { model: "codex/gpt-5.6-sol", reasoningEffort: "medium" },
      ),
    ).toMatchObject({
      model: "azure/gpt-5.6-terra",
      reasoningEffort: "high",
    });
  });
});
