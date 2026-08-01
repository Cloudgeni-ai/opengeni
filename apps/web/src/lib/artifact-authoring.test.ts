import { describe, expect, test } from "bun:test";

import {
  ARTIFACT_CREATE_PERMISSIONS,
  ARTIFACT_CREATE_TOOLS,
  ARTIFACT_EDIT_PERMISSIONS,
  ARTIFACT_EDIT_TOOLS,
  ARTIFACT_SESSION_TOOLS,
  applyNewSessionModelPreference,
  artifactCreateInstructions,
  artifactCreateOpeningMessage,
  artifactEditInstructions,
  artifactEditOpeningMessage,
} from "./artifact-authoring";

describe("artifact authoring sessions", () => {
  test("create stays in the current session and describes the real runtime", () => {
    const opening = artifactCreateOpeningMessage();
    const instructions = artifactCreateInstructions();

    expect(ARTIFACT_CREATE_TOOLS).toEqual(["artifacts_create"]);
    expect(ARTIFACT_CREATE_PERMISSIONS).toEqual(["artifacts:publish"]);
    expect(ARTIFACT_SESSION_TOOLS).toEqual([{ kind: "mcp", id: "opengeni" }]);
    expect(opening).toBe("Help me create a workspace artifact.");
    expect(opening).not.toContain("artifacts_create");
    expect(instructions).toContain("call artifacts_create yourself in this same session");
    expect(instructions).toContain("Do not create, spawn, or delegate to another session");
    expect(instructions).toContain("static HTML and inline CSS only");
    expect(instructions).toContain("JavaScript");
    expect(instructions).toContain("network requests");
    expect(instructions).toContain("downloads");
  });

  test("edit reads and publishes the exact artifact without orchestration tools", () => {
    const opening = artifactEditOpeningMessage("Status board");
    const instructions = artifactEditInstructions({
      artifactId: "artifact-1",
      title: "Status board",
      currentVersionId: "version-2",
    });

    expect(ARTIFACT_EDIT_TOOLS).toEqual(["artifacts_get_source", "artifacts_publish"]);
    expect(ARTIFACT_EDIT_PERMISSIONS).toEqual(["artifacts:read", "artifacts:publish"]);
    expect(ARTIFACT_SESSION_TOOLS).toEqual([{ kind: "mcp", id: "opengeni" }]);
    expect(opening).toBe("Help me edit “Status board”.");
    expect(opening).not.toContain("artifact id");
    expect(instructions).toContain("artifact id artifact-1");
    expect(instructions).toContain("current version version-2");
    expect(instructions).toContain("call artifacts_publish yourself in this same session");
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
