import { describe, expect, test } from "bun:test";
import type { WorkspaceStateResponse } from "@opengeni/sdk";
import { activeGlobalWorkspaceInstructionHead } from "./workspace-instructions";

function stateWithHeads(
  heads: WorkspaceStateResponse["policy"]["activeHeads"],
): WorkspaceStateResponse {
  return { policy: { activeHeads: heads } } as WorkspaceStateResponse;
}

describe("activeGlobalWorkspaceInstructionHead", () => {
  test("ignores charter and role heads that the focused editor cannot display", () => {
    const state = stateWithHeads([
      {
        kind: "charter",
        scope: "global",
        roleKey: null,
        revisionId: crypto.randomUUID(),
      },
      {
        kind: "policy",
        scope: "role",
        roleKey: "reviewer",
        revisionId: crypto.randomUUID(),
      },
    ] as WorkspaceStateResponse["policy"]["activeHeads"]);

    expect(activeGlobalWorkspaceInstructionHead(state)).toBeNull();
  });

  test("returns the global policy shown and edited as the workspace instruction", () => {
    const expected = {
      kind: "policy",
      scope: "global",
      roleKey: null,
      revisionId: crypto.randomUUID(),
    } as WorkspaceStateResponse["policy"]["activeHeads"][number];

    expect(activeGlobalWorkspaceInstructionHead(stateWithHeads([expected]))).toBe(expected);
  });
});
